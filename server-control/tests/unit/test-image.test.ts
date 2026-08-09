import { EventBridgeEvent } from 'aws-lambda';
import { describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ec2Send = jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>;

jest.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: jest.fn().mockImplementation(() => ({ send: ec2Send })),
    CreateImageCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.INSTANCE_ID = 'i-0123456789abcdef0';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../image');

type Detail = { 'instance-id': string; state: string };

const stoppedEvent = (time: string): EventBridgeEvent<'EC2 Instance State-change Notification', Detail> =>
    ({
        version: '0',
        id: 'event-id',
        'detail-type': 'EC2 Instance State-change Notification',
        source: 'aws.ec2',
        account: '123456789012',
        time,
        region: 'eu-west-2',
        resources: [],
        detail: { 'instance-id': 'i-0123456789abcdef0', state: 'stopped' },
    } as EventBridgeEvent<'EC2 Instance State-change Notification', Detail>);

describe('image handler', () => {
    beforeEach(() => {
        ec2Send.mockReset();
    });

    it('creates an AMI named and tagged with the event timestamp', async () => {
        ec2Send.mockResolvedValueOnce({ ImageId: 'ami-0123456789abcdef0' });

        await handler(stoppedEvent('2026-08-09T14:30:00Z'));

        expect(ec2Send).toHaveBeenCalledTimes(1);
        const command = ec2Send.mock.calls[0][0] as {
            input: {
                InstanceId: string;
                Name: string;
                TagSpecifications: { ResourceType: string; Tags: { Key: string; Value: string }[] }[];
            };
        };

        expect(command.input.InstanceId).toEqual('i-0123456789abcdef0');
        expect(command.input.Name).toEqual('Satisfactory-202608091430');

        const imageTags = command.input.TagSpecifications.find((spec) => spec.ResourceType === 'image');
        const snapshotTags = command.input.TagSpecifications.find((spec) => spec.ResourceType === 'snapshot');
        expect(imageTags?.Tags).toEqual([{ Key: 'Name', Value: 'Satisfactory-202608091430' }]);
        expect(snapshotTags?.Tags).toEqual([{ Key: 'Name', Value: 'Satisfactory-202608091430' }]);
    });

    it('rethrows when CreateImage fails', async () => {
        ec2Send.mockRejectedValueOnce(new Error('boom'));

        await expect(handler(stoppedEvent('2026-08-09T14:30:00Z'))).rejects.toThrow('boom');
    });
});
