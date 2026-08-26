type LogFields = Record<string, unknown>;

// With the function's LoggingConfig.LogFormat set to JSON, the Lambda Node.js
// runtime merges a single object argument into its structured log line
// (adding timestamp/level/requestId), so pass an object rather than a string.

/** Logs an info-level structured JSON entry. */
export const logInfo = (message: string, fields: LogFields = {}): void => console.log({ message, ...fields });
/** Logs a warn-level structured JSON entry. */
export const logWarn = (message: string, fields: LogFields = {}): void => console.warn({ message, ...fields });
/** Logs an error-level structured JSON entry. */
export const logError = (message: string, fields: LogFields = {}): void => console.error({ message, ...fields });
