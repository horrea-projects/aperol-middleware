import { CONFIG } from "../config";
import { httpRequest } from "./http";
const LOGS_KEY = "sync-uk:logs";
const LOGS_MAX = 200;

/** Envoie un log vers Redis (liste sync-uk:logs). N’utilise pas logger pour éviter les cycles. */
export async function pushLogEntry(entry: Record<string, unknown>): Promise<void> {
  if (!CONFIG.redis.enabled) return;
  try {
    const value = JSON.stringify(entry);
    const cmd = ["LPUSH", LOGS_KEY, value];
    await httpRequest<{ result?: string; error?: string }>(CONFIG.redis.restUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.redis.restToken}`,
        "Content-Type": "application/json"
      },
      body: cmd
    });
    const trim = ["LTRIM", LOGS_KEY, 0, LOGS_MAX - 1];
    await httpRequest<{ result?: string; error?: string }>(CONFIG.redis.restUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.redis.restToken}`,
        "Content-Type": "application/json"
      },
      body: trim
    });
  } catch {
    // Ne pas faire échouer le flux
  }
}
