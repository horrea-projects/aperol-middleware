import type { Handler } from "@netlify/functions";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import {
  getSlackEnvBaseline,
  invalidateSlackPolicyCache,
  resolveSlackPolicy,
} from "../../src/utils/slackPolicy";
import {
  loadSlackSettings,
  saveSlackSettings,
  type SlackSettingsPersisted,
} from "../../src/utils/slackSettingsStore";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  const authFail = guardDashboardAuth(event, CORS);
  if (authFail) return authFail;

  if (event.httpMethod === "GET") {
    try {
      invalidateSlackPolicyCache();
      const stored = await loadSlackSettings();
      const env = getSlackEnvBaseline();
      const effective = await resolveSlackPolicy();
      const webhookConfigured = Boolean((process.env.SLACK_WEBHOOK_URL ?? "").trim());
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          env,
          stored,
          effective: {
            notifications: effective.notifications,
            perRunReports: effective.perRunReports,
            dailyDigest: effective.dailyDigest,
          },
          source: effective.source,
          webhookConfigured,
        }),
      };
    } catch (e) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: String(e) }),
      };
    }
  }

  if (event.httpMethod === "PUT") {
    try {
      const raw = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
      const overridesActive = Boolean(raw.overridesActive);
      const next: SlackSettingsPersisted = {
        overridesActive,
        notificationsEnabled: Boolean(raw.notificationsEnabled),
        perRunReportsEnabled: Boolean(raw.perRunReportsEnabled),
        dailyDigestEnabled: Boolean(raw.dailyDigestEnabled),
        updatedAt: new Date().toISOString(),
      };
      if (overridesActive && !next.notificationsEnabled) {
        next.perRunReportsEnabled = false;
        next.dailyDigestEnabled = false;
      }
      await saveSlackSettings(next);
      invalidateSlackPolicyCache();
      const effective = await resolveSlackPolicy();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          stored: next,
          effective: {
            notifications: effective.notifications,
            perRunReports: effective.perRunReports,
            dailyDigest: effective.dailyDigest,
          },
          source: effective.source,
        }),
      };
    } catch (e) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: String(e) }),
      };
    }
  }

  return {
    statusCode: 405,
    headers: CORS,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};
