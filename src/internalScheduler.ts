import type { HandlerEvent } from "@netlify/functions";
import type { SyncTarget } from "./config";
import { runSyncUkScheduledOrManual } from "./handlers/syncUkNetlifyHandler";
import { logger } from "./utils/logger";

const DEFAULT_TICK_MS = 5 * 60_000;

function isInternalSyncCronEnabled(): boolean {
  const raw = (process.env.INTERNAL_SYNC_CRON ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Événement compatible avec `isNetlifyScheduledSyncInvocation` (garde intervalle dashboard). */
function createScheduledHandlerEvent(functionPath: string): HandlerEvent {
  const nextRun = new Date(Date.now() + DEFAULT_TICK_MS).toISOString();
  return {
    rawUrl: `http://internal${functionPath}`,
    rawQuery: "",
    path: functionPath,
    httpMethod: "POST",
    headers: {
      "x-nf-event": "schedule",
      "user-agent": "coolify-internal-scheduler",
    },
    multiValueHeaders: {},
    queryStringParameters: {},
    multiValueQueryStringParameters: null,
    body: JSON.stringify({ next_run: nextRun }),
    isBase64Encoded: false,
  };
}

async function runScheduledSync(target: SyncTarget): Promise<void> {
  const functionPath =
    target === "staging"
      ? "/.netlify/functions/sync-uk-staging"
      : "/.netlify/functions/sync-uk";
  try {
    const result = await runSyncUkScheduledOrManual(
      createScheduledHandlerEvent(functionPath),
      target,
    );
    logger.info("internal_scheduler_sync_done", {
      target,
      statusCode: result.statusCode,
      body: result.body.slice(0, 300),
    });
  } catch (err) {
    logger.error("internal_scheduler_sync_error", {
      target,
      error: String(err),
    });
  }
}

async function tick(): Promise<void> {
  logger.info("internal_scheduler_tick");
  await runScheduledSync("prod");
  await runScheduledSync("staging");
}

/**
 * Planificateur intégré (Coolify / Docker) : remplace les crons Netlify.
 * Respecte les réglages dashboard (`sync-schedule-settings`) : actif/inactif + intervalle.
 *
 * Désactiver : `INTERNAL_SYNC_CRON=0`
 * Granularité du tick : `INTERNAL_SYNC_CRON_TICK_MS` (défaut 5 min, comme netlify.toml)
 */
export function startInternalSyncScheduler(): void {
  if (!isInternalSyncCronEnabled()) {
    console.log("[scheduler] sync automatique désactivée (INTERNAL_SYNC_CRON=0)");
    return;
  }

  const tickMs = Number(process.env.INTERNAL_SYNC_CRON_TICK_MS) || DEFAULT_TICK_MS;
  if (!Number.isFinite(tickMs) || tickMs < 60_000) {
    console.warn(
      `[scheduler] INTERNAL_SYNC_CRON_TICK_MS invalide (${tickMs}), repli sur ${DEFAULT_TICK_MS}ms`,
    );
  }
  const interval = Number.isFinite(tickMs) && tickMs >= 60_000 ? tickMs : DEFAULT_TICK_MS;

  console.log(
    `[scheduler] sync automatique active — tick toutes les ${Math.round(interval / 60_000)} min`,
  );

  // Premier passage après 1 min (laisse le serveur et la config démarrer).
  setTimeout(() => {
    void tick();
  }, 60_000);

  setInterval(() => {
    void tick();
  }, interval);
}
