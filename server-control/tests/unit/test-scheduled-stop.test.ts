import { describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ec2Send = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;

jest.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: jest.fn().mockImplementation(() => ({ send: ec2Send })),
    StopInstancesCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.INSTANCE_ID = 'i-0123456789abcdef0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../scheduled-stop');

describe('scheduled-stop handler', () => {
    beforeEach(() => {
        ec2Send.mockReset();
    });

    it('stops the configured EC2 instance', async () => {
        ec2Send.mockResolvedValueOnce({
            StoppingInstances: [{ PreviousState: { Name: 'running' }, CurrentState: { Name: 'stopping' } }],
        });

        await handler();

        expect(ec2Send).toHaveBeenCalledTimes(1);
        const command = ec2Send.mock.calls[0][0] as { input: { InstanceIds: string[] } };
        expect(command.input).toEqual({ InstanceIds: ['i-0123456789abcdef0'] });
    });

    it('rethrows when stopping the instance fails', async () => {
        ec2Send.mockRejectedValueOnce(new Error('boom'));

        await expect(handler()).rejects.toThrow('boom');
    });
});