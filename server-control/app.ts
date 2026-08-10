import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { logError, logInfo, logWarn } from './logger';

const ec2 = new EC2Client({});
const route53 = new Route53Client({});

const INSTANCE_ID = process.env.INSTANCE_ID!;
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID!;
const DOMAIN_NAME = process.env.DOMAIN_NAME!;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';
const DNS_TTL = parseInt(process.env.DNS_TTL ?? "300");

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

const describeInstance = async () => {
    const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const instance = result.Reservations?.[0]?.Instances?.[0];
    return {
        status: instance?.State?.Name ?? 'unknown',
        publicIp: instance?.PublicIpAddress ?? null,
    };
};

const getStatus = async (user: CognitoUser): Promise<APIGatewayProxyResultV2> => {
    const { status, publicIp } = await describeInstance();
    logInfo('Instance status retrieved', { status, publicIp, user });
    return response(200, { status, publicIp });
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
