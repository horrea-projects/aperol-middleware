import type { SyncTarget } from "../config";
import {
  loadSlackSettings,
  pickTargetSettings,
  type SlackTargetSettingsPersisted,
} from "./slackSettingsStore";

function envFlag(key: string, defaultOn = true): boolean {
  const raw = (process.env[key] ?? (defaultOn ? "1" : "0")).trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  return defaultOn;
}

/** Staging : si `STAGING_*` est défini, il prévaut ; sinon repli sur `SLACK_*`. */
function envFlagStagingOrGlobal(stagingKey: string, globalKey: string, defaultOn: boolean): boolean {
  const s = (process.env[stagingKey] ?? "").trim();
  if (s !== "") return envFlag(stagingKey, defaultOn);
  return envFlag(globalKey, defaultOn);
}

/** Baseline fichier `.env` / Netlify pour une cible (sans surcharges dashboard). */
export function getSlackEnvBaseline(target: SyncTarget): {
  notifications: boolean;
  perRunReports: boolean;
  dailyDigest: boolean;
} {
  if (target === "staging") {
    const n = envFlagStagingOrGlobal("STAGING_SLACK_NOTIFICATIONS", "SLACK_NOTIFICATIONS", true);
    return {
      notifications: n,
      perRunReports: n && envFlagStagingOrGlobal("STAGING_SLACK_PER_RUN_REPORTS", "SLACK_PER_RUN_REPORTS", true),
      dailyDigest: n && envFlagStagingOrGlobal("STAGING_SLACK_DAILY_DIGEST", "SLACK_DAILY_DIGEST", true),
    };
  }
  const n = envFlag("SLACK_NOTIFICATIONS", true);
  return {
    notifications: n,
    perRunReports: n && envFlag("SLACK_PER_RUN_REPORTS", true),
    dailyDigest: n && envFlag("SLACK_DAILY_DIGEST", true),
  };
}

/** URL webhook Incoming pour digest hors contexte `getConfig()` (cron digest). */
export function getSlackWebhookUrlForTarget(target: SyncTarget): string {
  if (target === "staging") {
    const st = (process.env.STAGING_SLACK_WEBHOOK_URL ?? "").trim();
    if (st) return st;
  }
  return (process.env.SLACK_WEBHOOK_URL ?? "").trim();
}

export function isSlackWebhookConfiguredForTarget(target: SyncTarget): boolean {
  return Boolean(getSlackWebhookUrlForTarget(target).trim());
}

export type SlackPolicySource = "env" | "dashboard";

export interface SlackPolicy {
  notifications: boolean;
  perRunReports: boolean;
  dailyDigest: boolean;
  source: SlackPolicySource;
}

function policyFromPersisted(s: SlackTargetSettingsPersisted): SlackPolicy {
  const n = s.notificationsEnabled;
  return {
    notifications: n,
    perRunReports: n && s.perRunReportsEnabled,
    dailyDigest: n && s.dailyDigestEnabled,
    source: "dashboard",
  };
}

function policyFromEnv(target: SyncTarget): SlackPolicy {
  const b = getSlackEnvBaseline(target);
  return {
    notifications: b.notifications,
    perRunReports: b.perRunReports,
    dailyDigest: b.dailyDigest,
    source: "env",
  };
}

const cache = new Map<SyncTarget, { at: number; value: SlackPolicy }>();
const TTL_MS = 12_000;

export function invalidateSlackPolicyCache(): void {
  cache.clear();
}

/** Politique effective (env ou surcharges dashboard), avec court cache pour limiter les lectures Blob. */
export async function resolveSlackPolicy(target: SyncTarget): Promise<SlackPolicy> {
  const now = Date.now();
  const hit = cache.get(target);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const stored = await loadSlackSettings();
  const value =
    stored?.overridesActive === true
      ? policyFromPersisted(pickTargetSettings(stored, target))
      : policyFromEnv(target);
  cache.set(target, { at: now, value });
  return value;
}
