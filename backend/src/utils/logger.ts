import { getRequestId } from "../observability/request-context.js";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface LogSink {
  log(message: string): void;
}

const sensitiveFieldName = /password|passphrase|secret|authorization|token|jwt|webhook|phone|email|address|name|latitude|longitude|trackingcode/i;

function sanitizeFields(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    sensitiveFieldName.test(key) ? "[REDACTED]" : value,
  ]));
}

export function createLogger(
  environment: string,
  sink: LogSink = console,
) {
  return (level: LogLevel, event: string, fields: LogFields = {}) => {
    const requestId = getRequestId();
    const contextualFields = sanitizeFields(requestId && fields.requestId === undefined
      ? { requestId, ...fields }
      : fields);
    const entry = {
      ...contextualFields,
      timestamp: new Date().toISOString(),
      level,
      event,
    };

    if (environment === "production") {
      sink.log(JSON.stringify(entry));
      return;
    }

    const details = Object.keys(contextualFields).length > 0
      ? ` ${JSON.stringify(contextualFields)}`
      : "";
    sink.log(`[${level.toUpperCase()}] ${event}${details}`);
  };
}

const writeLog = (level: LogLevel, event: string, fields?: LogFields) =>
  createLogger(process.env.NODE_ENV ?? "development")(level, event, fields);

export const logger = {
  info: (event: string, fields?: LogFields) => writeLog("info", event, fields),
  warn: (event: string, fields?: LogFields) => writeLog("warn", event, fields),
  error: (event: string, fields?: LogFields) => writeLog("error", event, fields),
};
