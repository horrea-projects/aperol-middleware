import type { Handler } from "@netlify/functions";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import { bindNetlifyBlobsForLambda } from "../../src/utils/netlifyBlobsLambda";
import {
  SYNC_SCHEDULE_DEFAULT_INTERVAL_MINUTES,
  SYNC_SCHEDULE_MAX_MINUTES,
  SYNC_SCHEDULE_MIN_MINUTES,
  loadSyncSchedule,
  saveSyncSchedule,
  type SyncSchedulePersisted,
} from "../../src/utils/syncScheduleStore";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
};

/** Granularité du cron `netlify.toml` ([functions."sync-uk"]). */
const CRON_TICK_MINUTES = 5;

export const handler: Handler = async (event) => {
  bindNetlifyBlobsForLambda(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  const authFail = guardDashboardAuth(event, CORS);
  if (authFail) return authFail;

  if (event.httpMethod === "GET") {
    try {
      const stored = await loadSyncSchedule();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          cronTickMinutes: CRON_TICK_MINUTES,
          defaults: {
            intervalMinutes: SYNC_SCHEDULE_DEFAULT_INTERVAL_MINUTES,
            minMinutes: SYNC_SCHEDULE_MIN_MINUTES,
            maxMinutes: SYNC_SCHEDULE_MAX_MINUTES,
          },
          stored,
        }),
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e) }) };
    }
  }

  if (event.httpMethod === "PUT") {
    try {
      const raw = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
      const cur = await loadSyncSchedule();
      const next: SyncSchedulePersisted = {
        prodEnabled: Boolean(raw.prodEnabled),
        stagingEnabled: Boolean(raw.stagingEnabled),
        prodIntervalMinutes: Number(raw.prodIntervalMinutes ?? cur.prodIntervalMinutes),
        stagingIntervalMinutes: Number(raw.stagingIntervalMinutes ?? cur.stagingIntervalMinutes),
        lastRun: cur.lastRun,
        updatedAt: cur.updatedAt,
      };
      await saveSyncSchedule(next);
      const stored = await loadSyncSchedule();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, cronTickMinutes: CRON_TICK_MINUTES, stored }),
      };
    } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: String(e) }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
};
