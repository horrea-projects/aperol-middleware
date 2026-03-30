import type { Handler } from "@netlify/functions";
import { parseSyncTarget } from "../../src/config";
import { runSyncUkScheduledOrManual } from "../../src/handlers/syncUkNetlifyHandler";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import { bindNetlifyBlobsForLambda } from "../../src/utils/netlifyBlobsLambda";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "text/plain; charset=utf-8",
};

/**
 * Sync UK complète immédiate (sans attendre l’intervalle cron), après auth dashboard.
 * POST `/.netlify/functions/sync-uk-now?target=prod|staging`
 */
export const handler: Handler = async (event) => {
  bindNetlifyBlobsForLambda(event);
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...CORS, "Access-Control-Allow-Headers": "Content-Type, Cookie" },
      body: "",
    };
  }
  const authFail = guardDashboardAuth(event, CORS);
  if (authFail) return authFail;

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: "Method not allowed" };
  }

  const target = parseSyncTarget(event.queryStringParameters?.target);
  const r = await runSyncUkScheduledOrManual(event, target, { bypassScheduleGate: true });
  return { statusCode: r.statusCode, headers: CORS, body: r.body };
};
