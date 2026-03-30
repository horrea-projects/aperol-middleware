import { loadSlackSettings, type SlackSettingsPersisted } from "./slackSettingsStore";

function envFlag(key: string, defaultOn = true): boolean {
  const raw = (process.env[key] ?? (defaultOn ? "1" : "0")).trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  return defaultOn;
}

/** Baseline fichier `.env` / Netlify uniquement (sans surcharges dashboard). */
export function getSlackEnvBaseline(): {
  notifications: boolean;
  perRunReports: boolean;
  dailyDigest: boolean;
} {
  const n = envFlag("SLACK_NOTIFICATIONS", true);
  return {
    notifications: n,
    perRunReports: n && envFlag("SLACK_PER_RUN_REPORTS", true),
    dailyDigest: n && envFlag("SLACK_DAILY_DIGEST", true),
  };
}

export type SlackPolicySource = "env" | "dashboard";

export interface SlackPolicy {
  notifications: boolean;
  perRunReports: boolean;
  dailyDigest: boolean;
  source: SlackPolicySource;
}

function policyFromPersisted(s: SlackSettingsPersisted): SlackPolicy {
  const n = s.notificationsEnabled;
  return {
    notifications: n,
    perRunReports: n && s.perRunReportsEnabled,
    dailyDigest: n && s.dailyDigestEnabled,
    source: "dashboard",
  };
}

function policyFromEnv(): SlackPolicy {
  const b = getSlackEnvBaseline();
  return {
    notifications: b.notifications,
    perRunReports: b.perRunReports,
    dailyDigest: b.dailyDigest,
    source: "env",
  };
}

let cache: { at: number; value: SlackPolicy } | null = null;
const TTL_MS = 12_000;

export function invalidateSlackPolicyCache(): void {
  cache = null;
}

/** Politique effective (env ou surcharges dashboard), avec court cache pour limiter les lectures Blob. */
export async function resolveSlackPolicy(): Promise<SlackPolicy> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;

  const stored = await loadSlackSettings();
  const value =
    stored?.overridesActive === true ? policyFromPersisted(stored) : policyFromEnv();
  cache = { at: now, value };
  return value;
}
