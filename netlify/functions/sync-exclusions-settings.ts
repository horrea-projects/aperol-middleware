import type { Handler } from "@netlify/functions";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import { bindNetlifyBlobsForLambda } from "../../src/utils/netlifyBlobsLambda";
import { normalizeSku } from "../../src/utils/skuNormalize";
import {
  loadSyncExclusions,
  saveSyncExclusions,
  type SyncExclusionsPersisted,
} from "../../src/utils/syncExclusionsStore";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
};

function parseSkuCsv(raw: unknown): string[] {
  const str = String(raw ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of str.split(",")) {
    const sku = normalizeSku(part);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push(sku);
  }
  return out;
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
      const stored = await loadSyncExclusions();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ stored }) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String(e) }) };
    }
  }

  if (event.httpMethod === "PUT") {
    try {
      const raw = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
      const cur = await loadSyncExclusions();
      const next: SyncExclusionsPersisted = {
        prod: raw.prodCsv != null ? parseSkuCsv(raw.prodCsv) : cur.prod,
        staging: raw.stagingCsv != null ? parseSkuCsv(raw.stagingCsv) : cur.staging,
        updatedAt: cur.updatedAt,
      };
      await saveSyncExclusions(next);
      const stored = await loadSyncExclusions();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stored }) };
    } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: String(e) }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
};

