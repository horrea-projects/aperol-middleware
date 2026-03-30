import { getConfig } from "../config";
import { appendFileLogEntry } from "./fileLog";

type LogLevel = "info" | "error" | "warn";

interface LogMeta {
  [key: string]: unknown;
}

function baseLog(level: LogLevel, event: string, meta?: LogMeta) {
  let target: string | undefined;
  try {
    target = getConfig().target;
  } catch {
    /* pas de contexte ALS */
  }
  const payload: Record<string, unknown> = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(target ? { target } : {}),
    ...meta
  };
  if ("token" in (payload || {})) delete payload.token;
  if ("authorization" in (payload || {})) delete payload.authorization;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
  appendFileLogEntry(payload).catch(() => {});
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
