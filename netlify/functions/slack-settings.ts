import type { Handler } from "@netlify/functions";
import type { SyncTarget } from "../../src/config";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import { bindNetlifyBlobsForLambda } from "../../src/utils/netlifyBlobsLambda";
import {
  getSlackEnvBaseline,
  invalidateSlackPolicyCache,
  isSlackWebhookConfiguredForTarget,
  resolveSlackPolicy,
} from "../../src/utils/slackPolicy";
import {
  loadSlackSettings,
  saveSlackSettings,
  type SlackSettingsPersisted,
  type SlackTargetSettingsPersisted,
} from "../../src/utils/slackSettingsStore";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
};

function parseTargetBlock(raw: unknown): SlackTargetSettingsPersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    notificationsEnabled: Boolean(o.notificationsEnabled),
    perRunReportsEnabled: Boolean(o.perRunReportsEnabled),
    dailyDigestEnabled: Boolean(o.dailyDigestEnabled),
  };
}

function sanitizePair(p: SlackTargetSettingsPersisted): SlackTargetSettingsPersisted {
  const n = p.notificationsEnabled;
  return {
    notificationsEnabled: n,
    perRunReportsEnabled: n && p.perRunReportsEnabled,
    dailyDigestEnabled: n && p.dailyDigestEnabled,
  };
}

async function effectivePair(): Promise<Record<SyncTarget, Awaited<ReturnType<typeof resolveSlackPolicy>>>> {
  return {
    prod: await resolveSlackPolicy("prod"),
    staging: await resolveSlackPolicy("staging"),
  };
}

export const handler: Handler = async (event) => {
  bindNetlifyBlobsForLambda(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  const authFail = guardDashboardAuth(event, CORS);
  if (authFail) return authFail;

  if (event.httpMethod === "GET") {
    try {
      invalidateSlackPolicyCache();
      const stored = await loadSlackSettings();
      const env = {
        prod: getSlackEnvBaseline("prod"),
        staging: getSlackEnvBaseline("staging"),
      };
      const effective = await effectivePair();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          env,
          stored,
          effective,
          webhooks: {
            prodConfigured: isSlackWebhookConfiguredForTarget("prod"),
            stagingConfigured: isSlackWebhookConfiguredForTarget("staging"),
          },
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

      if (!overridesActive) {
        const cur = await loadSlackSettings();
        const nextOff: SlackSettingsPersisted = cur
          ? { ...cur, overridesActive: false, updatedAt: new Date().toISOString() }
          : {
              overridesActive: false,
              prod: {
                notificationsEnabled: getSlackEnvBaseline("prod").notifications,
                perRunReportsEnabled: getSlackEnvBaseline("prod").perRunReports,
                dailyDigestEnabled: getSlackEnvBaseline("prod").dailyDigest,
              },
              staging: {
                notificationsEnabled: getSlackEnvBaseline("staging").notifications,
                perRunReportsEnabled: getSlackEnvBaseline("staging").perRunReports,
                dailyDigestEnabled: getSlackEnvBaseline("staging").dailyDigest,
              },
              updatedAt: new Date().toISOString(),
            };
        await saveSlackSettings(nextOff);
        invalidateSlackPolicyCache();
        const effective = await effectivePair();
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            ok: true,
            stored: nextOff,
            effective,
            webhooks: {
              prodConfigured: isSlackWebhookConfiguredForTarget("prod"),
              stagingConfigured: isSlackWebhookConfiguredForTarget("staging"),
            },
          }),
        };
      }

      let prod = parseTargetBlock(raw.prod);
      let staging = parseTargetBlock(raw.staging);
      const prev = await loadSlackSettings();
      if (!prod && prev) prod = prev.prod;
      if (!staging && prev) staging = prev.staging;
      if (!prod || !staging) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: "Missing prod and/or staging Slack settings in body" }),
        };
      }
      prod = sanitizePair(prod);
      staging = sanitizePair(staging);

      const next: SlackSettingsPersisted = {
        overridesActive: true,
        prod,
        staging,
        updatedAt: new Date().toISOString(),
      };
      await saveSlackSettings(next);
      invalidateSlackPolicyCache();
      const effective = await effectivePair();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          stored: next,
          effective,
          webhooks: {
            prodConfigured: isSlackWebhookConfiguredForTarget("prod"),
            stagingConfigured: isSlackWebhookConfiguredForTarget("staging"),
          },
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
