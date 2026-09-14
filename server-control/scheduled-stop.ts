import { logError, logInfo } from './logger';
import { stopInstance } from './ec2';

const INSTANCE_ID = process.env.INSTANCE_ID!;

/** Stops the server on the daily EventBridge Scheduler invocation. */
export const handler = async (): Promise<void> => {
    logInfo('Scheduled instance stop initiated', { instanceId: INSTANCE_ID });

    try {
        const result = await stopInstance();
        const stateChange = result.StoppingInstances?.[0];
        logInfo('Scheduled instance stop request completed', {
            instanceId: INSTANCE_ID,
            previousState: stateChange?.PreviousState?.Name ?? 'unknown',
            currentState: stateChange?.CurrentState?.Name ?? 'unknown',
        });
    } catch (err) {
        logError('Scheduled instance stop failed', {
            instanceId: INSTANCE_ID,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
};