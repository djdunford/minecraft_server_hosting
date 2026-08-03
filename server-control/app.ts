import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';

const ec2 = new EC2Client({});
const route53 = new Route53Client({});

const INSTANCE_ID = process.env.INSTANCE_ID!;
const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID!;
const DOMAIN_NAME = process.env.DOMAIN_NAME!;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';

const response = (statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
    body: JSON.stringify(body),
});

const describeInstance = async () => {
    const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const instance = result.Reservations?.[0]?.Instances?.[0];
    return {
        status: instance?.State?.Name ?? 'unknown',
        publicIp: instance?.PublicIpAddress ?? null,
    };
};

const getStatus = async (): Promise<APIGatewayProxyResultV2> => {
    const { status, publicIp } = await describeInstance();
    return response(200, { status, publicIp });
};

const startServer = async (): Promise<APIGatewayProxyResultV2> => {
    const result = await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const stateChange = result.StartingInstances?.[0];
    return response(200, {
        message: 'Instance start initiated',
        previousState: stateChange?.PreviousState?.Name ?? 'unknown',
        currentState: stateChange?.CurrentState?.Name ?? 'unknown',
    });
};

const updateDns = async (): Promise<APIGatewayProxyResultV2> => {
    const { publicIp } = await describeInstance();
    if (!publicIp) {
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
                            TTL: 300,
                            ResourceRecords: [{ Value: publicIp }],
                        },
                    },
                ],
            },
        }),
    );

    return response(200, { message: 'DNS updated', ip: publicIp, domain: DOMAIN_NAME });
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
        switch (event.routeKey) {
            case 'GET /status':
                return await getStatus();
            case 'POST /start':
                return await startServer();
            case 'POST /update-dns':
                return await updateDns();
            default:
                return response(404, { message: 'Not found' });
        }
    } catch (err) {
        console.log(err);
        return response(500, { message: 'Internal server error' });
    }
};
