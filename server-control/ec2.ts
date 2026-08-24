import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({});

const INSTANCE_ID = process.env.INSTANCE_ID!;

export const describeInstance = async () => {
    const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    const instance = result.Reservations?.[0]?.Instances?.[0];
    return {
        status: instance?.State?.Name ?? 'unknown',
        publicIp: instance?.PublicIpAddress ?? null,
    };
};
