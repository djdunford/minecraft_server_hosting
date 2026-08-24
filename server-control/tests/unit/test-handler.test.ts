import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ec2Send = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const route53Send = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ssmSend = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const httpsRequest = jest.fn() as jest.Mock<(...args: any[]) => any>;

jest.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: jest.fn().mockImplementation(() => ({ send: ec2Send })),
    DescribeInstancesCommand: jest.fn().mockImplementation((input) => ({ input })),
    StartInstancesCommand: jest.fn().mockImplementation((input) => ({ input })),
    StopInstancesCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-route-53', () => ({
    Route53Client: jest.fn().mockImplementation(() => ({ send: route53Send })),
    ChangeResourceRecordSetsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: ssmSend })),
    GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('https', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (...args: any[]) => httpsRequest(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockHandlers = Record<string, (arg?: any) => void>;

const mockHttpsError = (message: string) => {
    httpsRequest.mockImplementation(() => {
        const handlers: MockHandlers = {};
        const req = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            on: (event: string, handler: (arg?: any) => void) => {
                handlers[event] = handler;
                return req;
            },
            write: () => undefined,
            end: () => handlers.error?.(new Error(message)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            destroy: (err?: any) => handlers.error?.(err ?? new Error(message)),
        };
        return req;
    });
};

const mockHttpsTimeout = () => {
    httpsRequest.mockImplementation(() => {
        const handlers: MockHandlers = {};
        const req = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            on: (event: string, handler: (arg?: any) => void) => {
                handlers[event] = handler;
                return req;
            },
            write: () => undefined,
            end: () => handlers.timeout?.(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            destroy: (err?: any) => handlers.error?.(err ?? new Error('timed out')),
        };
        return req;
    });
};

const mockHttpsSuccess = (body: string, statusCode = 200) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    httpsRequest.mockImplementation((_options: any, callback: (res: unknown) => void) => {
        const req = {
            on: () => req,
            write: () => undefined,
            end: () => {
                const res = {
                    statusCode,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    on: (event: string, handler: (arg?: any) => void) => {
                        if (event === 'data') handler(Buffer.from(body));
                        if (event === 'end') handler();
                        return res;
                    },
                };
                callback(res);
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            destroy: (_err?: any) => undefined,
        };
        return req;
    });
};

process.env.INSTANCE_ID = 'i-0123456789abcdef0';
process.env.HOSTED_ZONE_ID = 'Z05196342OPHB8ROH3JXW';
process.env.DOMAIN_NAME = 'sat.fivearcher.co.uk';
process.env.SATISFACTORY_API_TOKEN_PARAM = '/test-stack/satisfactory/api-token';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../app');

const baseEvent = (routeKey: string): APIGatewayProxyEventV2WithJWTAuthorizer =>
    ({
        version: '2.0',
        routeKey,
        rawPath: '/',
        rawQueryString: '',
        headers: {},
        requestContext: {
            authorizer: {
                jwt: {
                    claims: { sub: 'a1b2c3d4-0000-0000-0000-000000000000', email: 'player@example.com' },
                    scopes: [],
                },
            },
        } as never,
        isBase64Encoded: false,
    } as APIGatewayProxyEventV2WithJWTAuthorizer);

describe('server-control handler', () => {
    beforeEach(() => {
        ec2Send.mockReset();
        route53Send.mockReset();
        ssmSend.mockReset();
        ssmSend.mockRejectedValue(new Error('parameter not found'));
        httpsRequest.mockReset();
        mockHttpsError('connection refused');
    });

    it('GET /status returns online player count when the game API responds', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '1.2.3.4' }] }],
        });
        mockHttpsSuccess(JSON.stringify({ data: { serverGameState: { numConnectedPlayers: 3, playerLimit: 4 } } }));

        const result = await handler(baseEvent('GET /status'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            status: 'running',
            publicIp: '1.2.3.4',
            onlinePlayers: 3,
            playerLimit: 4,
        });
    });

    it('GET /status sends the SSM-stored token as a Bearer header to the game API', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '1.2.3.4' }] }],
        });
        ssmSend.mockReset();
        ssmSend.mockResolvedValueOnce({ Parameter: { Value: 'super-secret-token' } });
        mockHttpsSuccess(JSON.stringify({ data: { serverGameState: { numConnectedPlayers: 1, playerLimit: 4 } } }));

        await handler(baseEvent('GET /status'));

        expect(ssmSend).toHaveBeenCalledTimes(1);
        const ssmCommand = ssmSend.mock.calls[0][0] as { input: { Name: string; WithDecryption: boolean } };
        expect(ssmCommand.input).toEqual({ Name: '/test-stack/satisfactory/api-token', WithDecryption: true });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const requestOptions = httpsRequest.mock.calls[0][0] as any;
        expect(requestOptions.headers.Authorization).toEqual('Bearer super-secret-token');
    });

    it('GET /status returns null player counts when the game API call fails', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '1.2.3.4' }] }],
        });
        mockHttpsError('connection refused');

        const result = await handler(baseEvent('GET /status'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            status: 'running',
            publicIp: '1.2.3.4',
            onlinePlayers: null,
            playerLimit: null,
        });
    });

    it('GET /status returns null player counts when the game API times out', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '1.2.3.4' }] }],
        });
        mockHttpsTimeout();

        const result = await handler(baseEvent('GET /status'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            status: 'running',
            publicIp: '1.2.3.4',
            onlinePlayers: null,
            playerLimit: null,
        });
    });

    it('GET /status does not call the game API when instance is not running', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'stopped' }, PublicIpAddress: undefined }] }],
        });

        const result = await handler(baseEvent('GET /status'));

        expect(httpsRequest).not.toHaveBeenCalled();

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            status: 'stopped',
            publicIp: null,
            onlinePlayers: null,
            playerLimit: null,
        });
    });

    it('POST /start initiates instance start', async () => {
        ec2Send.mockResolvedValueOnce({
            StartingInstances: [{ PreviousState: { Name: 'stopped' }, CurrentState: { Name: 'pending' } }],
        });

        const result = await handler(baseEvent('POST /start'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            message: 'Instance start initiated',
            previousState: 'stopped',
            currentState: 'pending',
        });
    });

    it('POST /stop initiates instance stop', async () => {
        ec2Send.mockResolvedValueOnce({
            StoppingInstances: [{ PreviousState: { Name: 'running' }, CurrentState: { Name: 'stopping' } }],
        });

        const result = await handler(baseEvent('POST /stop'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            message: 'Instance stop initiated',
            previousState: 'running',
            currentState: 'stopping',
        });
        expect(ec2Send).toHaveBeenCalledTimes(1);
        const command = ec2Send.mock.calls[0][0] as { input: { InstanceIds: string[] } };
        expect(command.input).toEqual({ InstanceIds: ['i-0123456789abcdef0'] });
    });

    it('POST /update-dns upserts the A record when instance has a public IP', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '5.6.7.8' }] }],
        });
        route53Send.mockResolvedValueOnce({});

        const result = await handler(baseEvent('POST /update-dns'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({
            message: 'DNS updated',
            ip: '5.6.7.8',
            domain: 'sat.fivearcher.co.uk',
        });
        expect(route53Send).toHaveBeenCalledTimes(1);
        const command = route53Send.mock.calls[0][0] as { input: { ChangeBatch: { Changes: { ResourceRecordSet: { TTL: number } }[] } } };
        expect(command.input.ChangeBatch.Changes[0].ResourceRecordSet.TTL).toEqual(300);
    });

    it('POST /update-dns uses DNS_TTL env var when set', async () => {
        let isolatedHandler!: typeof handler;
        await jest.isolateModulesAsync(async () => {
            process.env.DNS_TTL = '5';
            isolatedHandler = require('../../app').handler;
        });

        try {
            ec2Send.mockResolvedValueOnce({
                Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '5.6.7.8' }] }],
            });
            route53Send.mockResolvedValueOnce({});

            await isolatedHandler(baseEvent('POST /update-dns'));

            const command = route53Send.mock.calls[0][0] as { input: { ChangeBatch: { Changes: { ResourceRecordSet: { TTL: number } }[] } } };
            expect(command.input.ChangeBatch.Changes[0].ResourceRecordSet.TTL).toEqual(5);
        } finally {
            delete process.env.DNS_TTL;
        }
    });

    it('POST /update-dns returns 400 when instance has no public IP', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'pending' }, PublicIpAddress: undefined }] }],
        });

        const result = await handler(baseEvent('POST /update-dns'));

        expect(result.statusCode).toEqual(400);
        expect(route53Send).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown routes', async () => {
        const result = await handler(baseEvent('GET /unknown'));

        expect(result.statusCode).toEqual(404);
    });

    it('returns 500 when a downstream call throws', async () => {
        ec2Send.mockRejectedValueOnce(new Error('boom'));

        const result = await handler(baseEvent('GET /status'));

        expect(result.statusCode).toEqual(500);
    });

    it('includes the Cognito user under $.message.user in structured log output', async () => {
        // The Lambda runtime's JSON log formatter nests a logged object under a top-level
        // "message" key, so the object logInfo/logError receive here is what ends up at $.message.
        const expectedUser = { sub: 'a1b2c3d4-0000-0000-0000-000000000000', email: 'player@example.com' };
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            ec2Send.mockResolvedValueOnce({
                Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '1.2.3.4' }] }],
            });
            await handler(baseEvent('GET /status'));
            expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ user: expectedUser }));

            ec2Send.mockRejectedValueOnce(new Error('boom'));
            await handler(baseEvent('GET /status'));
            expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ user: expectedUser }));
        } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });
});
