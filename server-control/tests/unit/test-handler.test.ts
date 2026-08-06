import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ec2Send = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const route53Send = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;

jest.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: jest.fn().mockImplementation(() => ({ send: ec2Send })),
    DescribeInstancesCommand: jest.fn().mockImplementation((input) => ({ input })),
    StartInstancesCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-route-53', () => ({
    Route53Client: jest.fn().mockImplementation(() => ({ send: route53Send })),
    ChangeResourceRecordSetsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.INSTANCE_ID = 'i-0123456789abcdef0';
process.env.HOSTED_ZONE_ID = 'Z05196342OPHB8ROH3JXW';
process.env.DOMAIN_NAME = 'sat.fivearcher.co.uk';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../app');

const baseEvent = (routeKey: string): APIGatewayProxyEventV2 =>
    ({
        version: '2.0',
        routeKey,
        rawPath: '/',
        rawQueryString: '',
        headers: {},
        requestContext: {} as never,
        isBase64Encoded: false,
    } as APIGatewayProxyEventV2);

describe('server-control handler', () => {
    beforeEach(() => {
        ec2Send.mockReset();
        route53Send.mockReset();
    });

    it('GET /status returns instance state and public IP', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'running' }, PublicIpAddress: '1.2.3.4' }] }],
        });

        const result = await handler(baseEvent('GET /status'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({ status: 'running', publicIp: '1.2.3.4' });
    });

    it('GET /status returns null IP when instance is stopped', async () => {
        ec2Send.mockResolvedValueOnce({
            Reservations: [{ Instances: [{ State: { Name: 'stopped' }, PublicIpAddress: undefined }] }],
        });

        const result = await handler(baseEvent('GET /status'));

        expect(result.statusCode).toEqual(200);
        expect(JSON.parse(result.body)).toEqual({ status: 'stopped', publicIp: null });
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
});
