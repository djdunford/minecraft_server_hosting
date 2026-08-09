import { EventBridgeEvent } from 'aws-lambda';
import { CreateImageCommand, EC2Client } from '@aws-sdk/client-ec2';
import { logError, logInfo } from './logger';

const ec2 = new EC2Client({});

const INSTANCE_ID = process.env.INSTANCE_ID!;

type Ec2StateChangeDetail = {
    'instance-id': string;
    state: string;
};

export const handler = async (
    event: EventBridgeEvent<'EC2 Instance State-change Notification', Ec2StateChangeDetail>,
): Promise<void> => {
    const timestamp = event.time.replace(/\D/g, '').slice(0, 12);
    const name = `Satisfactory-${timestamp}`;

    logInfo('Instance stopped, creating backup AMI', { instanceId: INSTANCE_ID, name, stoppedAt: event.time });

    try {
        const result = await ec2.send(
            new CreateImageCommand({
                InstanceId: INSTANCE_ID,
                Name: name,
                Description: `Automatic backup created when the Satisfactory server stopped at ${event.time}`,
                TagSpecifications: [
                    { ResourceType: 'image', Tags: [{ Key: 'Name', Value: name }] },
                    { ResourceType: 'snapshot', Tags: [{ Key: 'Name', Value: name }] },
                ],
            }),
        );

        logInfo('Created backup AMI', { instanceId: INSTANCE_ID, imageId: result.ImageId, name });
    } catch (err) {
        logError('Failed to create backup AMI', {
            instanceId: INSTANCE_ID,
            name,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
};
