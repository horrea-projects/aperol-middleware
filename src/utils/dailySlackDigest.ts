import type { SyncTarget } from "../config";
import type { StockSyncResult } from "../jobs/stockSync";
import { ensureLocalEnvLoaded } from "./loadEnvFile";
import { logger } from "./logger";
import { postSlackIncomingWebhook } from "./slack";
import {
  getSlackWebhookUrlForTarget,
  resolveSlackPolicy,
} from "./slackPolicy";
import {
  type SyncRunRecord,
  SYNC_RUN_HISTORY_CAP,
} from "./syncRunHistory";

const DEFAULT_TZ = "Europe/Paris";
const MAX_SKU_LIST = 30;

function formatYmdInTimeZone(isoOrDate: Date | string, timeZone: string): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map((x) => Number(x));
  const utc = Date.UTC(y, m - 1, d + deltaDays);
  return new Date(utc).toISOString().slice(0, 10);
}

/** Journée civile « hier » dans le fuseau (au moment de l’exécution du cron). */
export function yesterdayYmdInTimezone(now: Date, timeZone: string): string {
  const todayYmd = formatYmdInTimeZone(now, timeZone);
  return addCalendarDaysYmd(todayYmd, -1);
}

export function filterRunsForCalendarDay(
  runs: SyncRunRecord[],
  ymd: string,
  timeZone: string,
): SyncRunRecord[] {
  return runs.filter((r) => formatYmdInTimeZone(r.at, timeZone) === ymd);
}

function isStockSyncDetail(d: unknown): d is StockSyncResult {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return Array.isArray(o.lines) && typeof o.appliedItems === "number";
}

export type DailyDigestWarning =
  | "history_truncated"
  | "no_runs_yesterday"
  | "no_webhook";

export interface DailyDigestBuildResult {
  text: string;
  warnings: DailyDigestWarning[];
}

function accumulateFailedSkus(runs: SyncRunRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const run of runs) {
    const d = run.stock.detail;
    if (!isStockSyncDetail(d)) continue;
    for (const line of d.lines) {
      if (line.status === "adjusted") continue;
      const m0 = line.messages?.[0]?.slice(0, 80);
      const label = `${line.status}${m0 ? ` (${m0})` : ""}${line.error ? ` — ${line.error.slice(0, 80)}` : ""}`;
      if (!map.has(line.sku)) map.set(line.sku, label);
    }
  }
  return map;
}

function sectionForTarget(
  label: string,
  runs: SyncRunRecord[],
  failedSkus: Map<string, string>,
): string {
  if (runs.length === 0) {
    return `*${label}*\n_Aucune sync enregistrée pour cette journée._\n`;
  }

  const syncUk = runs.filter((r) => r.kind === "sync-uk").length;
  const stockOnly = runs.filter((r) => r.kind === "stock").length;
  const runFailures = runs.filter((r) => !r.stock.ok).length;

  let successAdj = 0;
  let failedLineCount = 0;
  let durationSum = 0;

  for (const r of runs) {
    successAdj += r.stock.success;
    failedLineCount += r.stock.failed;
    durationSum += r.durationSec;
  }

  const durAvg = runs.length ? Math.round(durationSum / runs.length) : 0;
  const durMax = runs.length ? Math.max(...runs.map((r) => r.durationSec)) : 0;

  const lines: string[] = [
    `*${label}*`,
    `• Exécutions enregistrées : *${runs.length}* (sync complète \`sync-uk\` : ${syncUk}, sync stock seul : ${stockOnly})`,
    `• Ajustements Shopify appliqués (Σ succès) : *${successAdj}*`,
    `• Lignes en erreur / ignorées (Σ) : *${failedLineCount}* (erreurs API Shopify + SKU sans article d’inventaire, cumul sur la journée)`,
    `• Runs avec statut stock « non OK » : *${runFailures}*`,
    `• Durée des runs : moy. ~${durAvg}s, max ${durMax}s`,
  ];

  const broken = runs.filter((r) => !r.stock.ok);
  if (broken.length > 0) {
    lines.push(`• Détail des échecs globaux (extrait) :`);
    for (const r of broken.slice(0, 8)) {
      const msg = r.stock.error?.slice(0, 120) ?? "(voir dashboard / JSON du run)";
      lines.push(`  ◦ \`${r.id}\` — ${msg}`);
    }
    if (broken.length > 8) lines.push(`  _… ${broken.length - 8} autre(s) run(s)_`);
  }

  if (failedSkus.size > 0) {
    const entries = [...failedSkus.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const shown = entries.slice(0, MAX_SKU_LIST);
    const rest = entries.length - shown.length;
    lines.push(`• SKU touchés par au moins une erreur / skip (*${failedSkus.size}*) :`);
    for (const [sku, reason] of shown) {
      lines.push(`  ◦ \`${sku}\` — ${reason}`);
    }
    if (rest > 0) lines.push(`  _… et ${rest} autre(s) SKU_`);
  } else if (failedLineCount > 0) {
    lines.push(`• _Détail SKU indisponible (runs sans lignes dans l’historique)._`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Rapport journalier pour un seul environnement (webhook / politique indépendants prod vs staging). */
export function buildDailyDigestTextForTarget(options: {
  runsInStore: SyncRunRecord[];
  reportYmd: string;
  timeZone: string;
  siteLabel?: string;
  target: SyncTarget;
}): DailyDigestBuildResult {
  const { runsInStore, reportYmd, timeZone, target } = options;
  const site = options.siteLabel?.trim() || "Middleware UK";

  const warnings: DailyDigestWarning[] = [];
  const yesterdayRuns = filterRunsForCalendarDay(runsInStore, reportYmd, timeZone);
  const targetRuns = yesterdayRuns.filter((r) => r.target === target);

  if (runsInStore.length >= SYNC_RUN_HISTORY_CAP) {
    warnings.push("history_truncated");
  }

  if (targetRuns.length === 0) {
    warnings.push("no_runs_yesterday");
  }

  const label = target === "prod" ? "Production (`prod`)" : "Staging (`staging`)";
  const failedSkus = accumulateFailedSkus(targetRuns);
  const section = sectionForTarget(label, targetRuns, failedSkus);

  const envTitle = target === "prod" ? "Production" : "Staging";
  const header = [
    `:calendar: *Rapport journalier — ${reportYmd}* (${timeZone}) — *${envTitle}*`,
    `_Synthèse des synchronisations stock (historique middleware). Site : ${site}_`,
    "",
  ];

  if (warnings.includes("history_truncated")) {
    header.push(
      `:warning: _L’historique stocké ne remonte peut‑être pas au début de cette journée (runs trop anciens évincés). Les totaux peuvent être incomplets._`,
      "",
    );
  }

  let body = section;
  if (warnings.includes("no_runs_yesterday") && targetRuns.length === 0) {
    body =
      `_Aucune sync enregistrée pour le ${reportYmd} (${target}) — vérifier les crons Netlify ou que l’historique n’a pas été réinitialisé._\n\n` +
      body;
  }

  return {
    text: [...header, body].join("\n"),
    warnings,
  };
}

export async function sendDailySlackDigestFromEnv(now: Date = new Date()): Promise<{
  sent: boolean;
  skipReason?: string;
  reportYmd?: string;
  timeZone?: string;
  targetsSent?: SyncTarget[];
}> {
  ensureLocalEnvLoaded();

  const timeZone = (process.env.SLACK_DAILY_DIGEST_TIMEZONE ?? DEFAULT_TZ).trim() || DEFAULT_TZ;
  const reportYmd = yesterdayYmdInTimezone(now, timeZone);
  const siteLabel = process.env.SLACK_DAILY_DIGEST_SITE_LABEL?.trim();

  const { loadSyncHistorySnapshot } = await import("./syncRunHistory");
  const runsInStore = await loadSyncHistorySnapshot();

  const order: SyncTarget[] = ["prod", "staging"];
  const targetsSent: SyncTarget[] = [];

  for (const target of order) {
    const policy = await resolveSlackPolicy(target);
    if (!policy.notifications || !policy.dailyDigest) {
      logger.info("daily_slack_digest_skip", { target, reason: "slack_digest_or_notifications_off" });
      continue;
    }
    const webhook = getSlackWebhookUrlForTarget(target);
    if (!webhook) {
      logger.info("daily_slack_digest_skip", { target, reason: "no_webhook" });
      continue;
    }
    const { text, warnings } = buildDailyDigestTextForTarget({
      runsInStore,
      reportYmd,
      timeZone,
      siteLabel,
      target,
    });
    await postSlackIncomingWebhook(target, webhook, { text });
    targetsSent.push(target);
    logger.info("daily_slack_digest_sent", { target, reportYmd, timeZone, warnings });
  }

  if (targetsSent.length === 0) {
    return {
      sent: false,
      skipReason: "no_target_eligible_or_no_webhook",
      reportYmd,
      timeZone,
    };
  }

  return { sent: true, reportYmd, timeZone, targetsSent };
}
