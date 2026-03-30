import type { Handler, HandlerEvent } from "@netlify/functions";
import { assertConfig, buildConfig, runWithConfig, type SyncTarget } from "../config";
import { runStockSync } from "../jobs/stockSync";
import { bindNetlifyBlobsForLambda } from "../utils/netlifyBlobsLambda";
import { isNetlifyScheduledSyncInvocation } from "../utils/netlifyScheduledEvent";
import { withExecutionLock } from "../utils/locks";
import { logger } from "../utils/logger";
import { sendSlackRunReport } from "../utils/slack";
import { evaluateSyncUkScheduleGate, touchSyncUkLastRun } from "../utils/syncScheduleStore";
import {
  appendSyncRun,
  buildStockOnlyRunRecord,
  buildSyncUkRunRecord,
} from "../utils/syncRunHistory";

export interface RunSyncUkOptions {
  /** Sync immédiate depuis le dashboard (ignore la garde cron / intervalle). */
  bypassScheduleGate?: boolean;
}

/**
 * Sync UK complète (stock) avec garde temporelle pour les invocations planifiées Netlify.
 */
export async function runSyncUkScheduledOrManual(
  event: HandlerEvent,
  target: SyncTarget,
  options: RunSyncUkOptions = {},
): Promise<{ statusCode: number; body: string }> {
  bindNetlifyBlobsForLambda(event);
  const config = buildConfig(target);
  if (target === "staging" && !config.shopify.storeDomain) {
    return {
      statusCode: 200,
      body: "Sync staging ignorée (aucune boutique staging : STAGING_SHOPIFY_STORE_DOMAIN vide)",
    };
  }
  try {
    assertConfig(config);
  } catch (err) {
    logger.error("config_error", { target, error: String(err) });
    return {
      statusCode: 500,
      body: `Configuration invalide (${target}): ${String(err)}`,
    };
  }

  const scheduled = options.bypassScheduleGate ? false : isNetlifyScheduledSyncInvocation(event);
  const gate = await evaluateSyncUkScheduleGate({
    target,
    isScheduledInvocation: scheduled,
  });
  if (gate.skip) {
    const body =
      gate.reason === "schedule_disabled"
        ? `Sync UK (${target}) — planification serveur désactivée (dashboard)`
        : gate.reason === "too_soon" && gate.waitMinutesApprox != null
          ? `Sync UK (${target}) — ignorée (intervalle ; encore ~${gate.waitMinutesApprox} min)`
          : `Sync UK (${target}) — ignorée (planification)`;
    logger.info("sync_uk_skipped_by_schedule", { target, reason: gate.reason, scheduled });
    return { statusCode: 200, body };
  }

  return runWithConfig(config, async () => {
    await touchSyncUkLastRun(target);
    const runId = `sync-uk:${target}:${Date.now()}`;
    const startedAt = Date.now();

    const result = await withExecutionLock(60 * 9, async () => {
      const stockRes = await Promise.allSettled([runStockSync()]);
      return {
        runId,
        stockRes: stockRes[0],
        stock:
          stockRes[0].status === "fulfilled"
            ? stockRes[0].value
            : { error: String(stockRes[0].reason) },
      };
    });

    const durationMs = Date.now() - startedAt;
    const durationSec = Math.round(durationMs / 1000);

    await appendSyncRun(
      buildSyncUkRunRecord(target, result.runId, durationSec, result.stockRes),
    );

    const stockAny = result.stock as Record<string, unknown> & { error?: string; userErrors?: number };
    const stockErrors =
      typeof stockAny?.error === "string" ? 1 : (stockAny.userErrors ?? 0);
    const hadErrors = stockErrors > 0;

    await sendSlackRunReport(
      hadErrors ? `[ALERTE] sync-uk ${target} — erreurs stock` : `sync-uk ${target} — OK`,
      {
        target,
        runId: result.runId,
        durationSec,
        stock: result.stock,
        errorsCountApprox: { stockErrors },
      },
    );

    return {
      statusCode: 200,
      body: `Sync UK (${target}) terminée (runId=${result.runId})`,
    };
  });
}

export function createSyncUkHandler(target: SyncTarget): Handler {
  return (event) => runSyncUkScheduledOrManual(event, target);
}

export function createStockSyncHandler(target: SyncTarget): Handler {
  return async (event) => {
    bindNetlifyBlobsForLambda(event);
    const config = buildConfig(target);
    if (target === "staging" && !config.shopify.storeDomain) {
      return { statusCode: 200, body: "Sync staging ignorée (aucune boutique staging)" };
    }

    try {
      assertConfig(config);
    } catch (err) {
      logger.error("config_error", { target, error: String(err) });
      return { statusCode: 500, body: `Configuration invalide (${target}): ${String(err)}` };
    }

    return runWithConfig(config, async () => {
      const runId = `sync-stock:${target}:${Date.now()}`;
      const startedAt = Date.now();

      const stockRes = await withExecutionLock(60 * 9, runStockSync);
      if (stockRes === null) {
        return { statusCode: 200, body: `Sync stock (${target}) ignorée (lock actif)` };
      }

      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      const hadErrors = stockRes.userErrors > 0;

      await appendSyncRun(buildStockOnlyRunRecord(target, runId, durationSec, stockRes));

      await sendSlackRunReport(
        hadErrors ? `[ALERTE] sync stock ${target} — erreurs` : `sync stock ${target} — OK`,
        {
          target,
          runId,
          durationSec,
          stock: stockRes,
        },
      );

      return { statusCode: 200, body: `Sync stock (${target}) terminée (runId=${runId})` };
    });
  };
}
