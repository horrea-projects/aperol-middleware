import { pushLogEntry } from "./redisLog";

type LogLevel = "info" | "error" | "warn";

interface LogMeta {
  [key: string]: unknown;
}

function baseLog(level: LogLevel, event: string, meta?: LogMeta) {
  const payload: Record<string, unknown> = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...meta
  };
  if ("token" in (payload || {})) delete payload.token;
  if ("authorization" in (payload || {})) delete payload.authorization;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
  pushLogEntry(payload).catch(() => {});
}

export const logger = {
  info(event: string, meta?: LogMeta) {
    baseLog("info", event, meta);
  },
  warn(event: string, meta?: LogMeta) {
    baseLog("warn", event, meta);
  },
  error(event: string, meta?: LogMeta) {
    baseLog("error", event, meta);
  }
};

