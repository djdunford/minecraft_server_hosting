import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { logError, logInfo, logWarn } from './logger';
import { describeInstance } from './ec2';
import { queryServerState } from './satisfactory-api';

const ec2 = new EC2Client({});
const route53 = new Route53Client({});
const ssm = new SSMClient({});

const INSTANCE_ID = process.env.INSTANCE_ID!;
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID!;
const DOMAIN_NAME = process.env.DOMAIN_NAME!;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';
const DNS_TTL = parseInt(process.env.DNS_TTL ?? '300');
const SATISFACTORY_API_PORT = process.env.SATISFACTORY_API_PORT ?? '7777';
const SATISFACTORY_API_TOKEN_PARAM = process.env.SATISFACTORY_API_TOKEN_PARAM!;

const response = (statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
    body: JSON.stringify(body),
});

type CognitoUser = {
    sub?: string;
    email?: string;
};

const getCognitoUser = (event: APIGatewayProxyEventV2WithJWTAuthorizer): CognitoUser => {
    const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
    return {
        sub: typeof claims.sub === 'string' ? claims.sub : undefined,
        email: typeof claims.email === 'string' ? claims.email : undefined,
    };
};

/**
 * Fetches the Satisfactory API Bearer token from Parameter Store.
 *
 * The token is stored out-of-band (see README) rather than as a Lambda env
 * var so it can be rotated without a redeploy. Returns `undefined` — rather
 * than throwing — if the parameter is missing or unreadable, so callers can
 * proceed without auth.
 */
const getApiToken = async (): Promise<string | undefined> => {
    try {
        const result = await ssm.send(
            new GetParameterCommand({ Name: SATISFACTORY_API_TOKEN_PARAM, WithDecryption: true }),
        );
        return result.Parameter?.Value;
    } catch (err) {
        logWarn('Failed to fetch Satisfactory API token from Parameter Store', {
            parameter: SATISFACTORY_API_TOKEN_PARAM,
            error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
};

/**
 * Handles `GET /status`. Reports EC2 instance state/public IP, plus online
 * player count and limit when the instance is running — the latter queried
 * live from the Satisfactory Dedicated Server's HTTPS API. If that API call
 * fails for any reason, player counts fall back to `null` rather than
 * failing the whole request.
 */
const getStatus = async (user: CognitoUser): Promise<APIGatewayProxyResultV2> => {
    const { status, publicIp } = await describeInstance();

    let onlinePlayers: number | null = null;
    let playerLimit: number | null = null;
    if (status === 'running' && publicIp) {
        try {
            const token = await getApiToken();
            ({ onlinePlayers, playerLimit } = await queryServerState(publicIp, SATISFACTORY_API_PORT, token));
        } catch (err) {
            logWarn('Failed to query game server state', {
                publicIp,
                error: err instanceof Error ? err.message : String(err),
                user,
            });
        }
    }

    logInfo('Instance status retrieved', { status, publicIp, onlinePlayers, playerLimit, user });
    return response(200, { status, publicIp, onlinePlayers, playerLimit });
};

const startServer = async (user: CognitoUser): Promise<APIGatewayProxyResultV2> => {
    const result = await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const stateChange = result.StartingInstances?.[0];
    const previousState = stateChange?.PreviousState?.Name ?? 'unknown';
    const currentState = stateChange?.CurrentState?.Name ?? 'unknown';
    logInfo('Instance start initiated', { instanceId: INSTANCE_ID, previousState, currentState, user });
    return response(200, {
        message: 'Instance start initiated',
        previousState,
        currentState,
    });
};

const stopServer = async (user: CognitoUser): Promise<APIGatewayProxyResultV2> => {
    const result = await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const stateChange = result.StoppingInstances?.[0];
    const previousState = stateChange?.PreviousState?.Name ?? 'unknown';
    const currentState = stateChange?.CurrentState?.Name ?? 'unknown';
    logInfo('Instance stop initiated', { instanceId: INSTANCE_ID, previousState, currentState, user });
    return response(200, {
        message: 'Instance stop initiated',
        previousState,
        currentState,
    });
};

const updateDns = async (user: CognitoUser): Promise<APIGatewayProxyResultV2> => {
    const { publicIp } = await describeInstance();
    if (!publicIp) {
        logWarn('DNS update skipped: instance has no public IP', { instanceId: INSTANCE_ID, user });
        return response(400, { message: 'Instance has no public IP. Is it running?' });
    }

    await route53.send(
        new ChangeResourceRecordSetsCommand({
            HostedZoneId: HOSTED_ZONE_ID,
            ChangeBatch: {
                Changes: [
                    {
                        Action: 'UPSERT',
                        ResourceRecordSet: {
                            Name: DOMAIN_NAME,
                            Type: 'A',
                            TTL: DNS_TTL,
                            ResourceRecords: [{ Value: publicIp }],
                        },
                    },
                ],
            },
        }),
    );

    logInfo('DNS updated', { domain: DOMAIN_NAME, ip: publicIp, ttl: DNS_TTL, user });
    return response(200, { message: 'DNS updated', ip: publicIp, domain: DOMAIN_NAME });
};

/**
 * API Gateway entry point for the server-control API. Routes Cognito-authenticated
 * requests to the `/status`, `/start`, `/stop`, and `/update-dns` handlers.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const user = getCognitoUser(event);
    try {
        switch (event.routeKey) {
            case 'GET /status':
                return await getStatus(user);
            case 'POST /start':
                return await startServer(user);
            case 'POST /stop':
                return await stopServer(user);
            case 'POST /update-dns':
                return await updateDns(user);
            default:
                logWarn('Route not found', { routeKey: event.routeKey, user });
                return response(404, { message: 'Not found' });
        }
    } catch (err) {
        logError('Unhandled error processing request', {
            routeKey: event.routeKey,
            error: err instanceof Error ? err.message : String(err),
            user,
        });
        return response(500, { message: 'Internal server error' });
    }
};
