import { CONFIG } from "../config";
import { httpRequest } from "./http";
import { logger } from "./logger";

const EXECUTION_LOCK_KEY = "sync-uk:execution-lock";
const SHIPMENT_CHECKPOINT_KEY = "sync-uk:last-shipment-sync";
export const LOGS_KEY = "sync-uk:logs";
const LOGS_MAX = 200;

/** Upstash REST: body = tableau [COMMAND, ...args], réponse = { result } ou { error }. */
async function redisCommand<T = unknown>(command: unknown[]): Promise<T> {
  if (!CONFIG.redis.enabled) throw new Error("Redis non configuré");
  const res = await httpRequest<{ result?: T; error?: string }>(CONFIG.redis.restUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.redis.restToken}`,
      "Content-Type": "application/json"
    },
    body: command
  });
  if (res.error) throw new Error(res.error);
  return res.result as T;
}

export async function withExecutionLock<T>(ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
  if (!CONFIG.redis.enabled) {
    logger.warn("execution_lock_disabled", { reason: "redis_not_configured" });
    return fn();
  }

  try {
    const result = await redisCommand<string | null>([
      "SET", EXECUTION_LOCK_KEY, "1", "NX", "EX", ttlSeconds
    ]);
    if (result !== "OK") {
      logger.info("execution_lock_skipped", { key: EXECUTION_LOCK_KEY });
      return null;
    }
  } catch (err) {
    logger.error("execution_lock_error", { error: String(err) });
  }

  try {
    return await fn();
  } finally {
    try {
      await redisCommand(["DEL", EXECUTION_LOCK_KEY]);
    } catch (err) {
      logger.error("execution_lock_release_error", { error: String(err) });
    }
  }
}

export async function getLastShipmentCheckpoint(): Promise<string | null> {
  if (!CONFIG.redis.enabled) return null;
  try {
    return await redisCommand<string | null>(["GET", SHIPMENT_CHECKPOINT_KEY]);
  } catch (err) {
    logger.error("checkpoint_read_error", { error: String(err) });
    return null;
  }
}

export async function setLastShipmentCheckpoint(timestampIso: string): Promise<void> {
  if (!CONFIG.redis.enabled) return;
  try {
    await redisCommand(["SET", SHIPMENT_CHECKPOINT_KEY, timestampIso]);
  } catch (err) {
    logger.error("checkpoint_write_error", { error: String(err) });
  }
}

/** Retourne les N derniers logs (ordre chronologique inverse = plus récent en premier). */
export async function getLogEntries(limit: number = 100): Promise<Record<string, unknown>[]> {
  if (!CONFIG.redis.enabled) return [];
  try {
    const raw = await redisCommand<string[] | null>(["LRANGE", LOGS_KEY, 0, limit - 1]);
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return { message: s };
      }
    });
  } catch (err) {
    logger.error("logs_read_error", { error: String(err) });
    return [];
  }
}

