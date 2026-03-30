import type { Handler } from "@netlify/functions";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildConfig,
  getProdConfig,
  runWithConfig
} from "../../src/config";
import { ShopifyService } from "../../src/services/shopifyService";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json"
};

type LogEntry = {
  level?: string;
  event?: string;
  timestamp?: string;
  target?: string;
  processed?: number;
  reason?: string;
  summary?: unknown;
  error?: string;
};

function safeParseJsonLine(line: string): LogEntry | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== "object") return null;
    return obj as LogEntry;
  } catch {
    return null;
  }
}

function formatAt(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function readJsonlLogFile(logPath: string, maxLines: number = 8000): Promise<LogEntry[]> {
  const resolved = path.isAbsolute(logPath) ? logPath : path.join(process.cwd(), logPath);
  const content = await fs.readFile(resolved, { encoding: "utf8" }).catch(() => "");
  if (!content) return [];
  const lines = content.split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - maxLines));
  const parsed = slice.map(safeParseJsonLine).filter((x): x is LogEntry => Boolean(x));
  return parsed;
}

function computeLastSyncFromLogs(entries: LogEntry[]): {
  prod: Record<string, unknown>;
  staging: Record<string, unknown>;
} {
  const targets = ["prod", "staging"];
  const out: Record<string, any> = {
    prod: { lastStockSync: null, lastError: null },
    staging: { lastStockSync: null, lastError: null }
  };

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const target = String(e.target || "");
    if (!targets.includes(target)) continue;

    if (!out[target].lastStockSync && e.event === "stock_sync_completed") {
      out[target].lastStockSync = {
        at: e.timestamp ? formatAt(e.timestamp) : null,
        processed: typeof e.processed === "number" ? e.processed : null,
        reason: typeof e.reason === "string" ? e.reason : null,
        summary: e.summary ?? null
      };
      continue;
    }

    if (!out[target].lastError && e.level === "error") {
      out[target].lastError = {
        at: e.timestamp ? formatAt(e.timestamp) : null,
        event: e.event ?? null,
        error: e.error ?? null
      };
      continue;
    }
  }

  return out as any;
}

async function checkShopifyConnection(target: "prod" | "staging"): Promise<{
  ok: boolean;
  locationName: string | null;
  message: string | null;
}> {
  return runWithConfig(buildConfig(target), async () => {
    const shopify = new ShopifyService();
    try {
      const locationName = await shopify.fetchUkLocationName();
      return { ok: true, locationName, message: null };
    } catch (err) {
      return { ok: false, locationName: null, message: String(err) };
    }
  });
}

export const handler: Handler = async (event) => {
  const authFail = guardDashboardAuth(event, CORS_HEADERS);
  if (authFail) return authFail;

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Connexion
  const [prodShopify, stagingShopify] = await Promise.all([
    checkShopifyConnection("prod"),
    checkShopifyConnection("staging")
  ]);

  // Config WMS/Byrd (rapide, sans appel réseau)
  const prodCfg = buildConfig("prod");
  const stagingCfg = buildConfig("staging");
  const prodByrd = !!prodCfg.byrd.apiKey && !!prodCfg.byrd.apiSecret;
  const stagingByrd = !!stagingCfg.byrd.apiKey && !!stagingCfg.byrd.apiSecret;
  const prodWms = !!prodCfg.wms.baseUrl && !!prodCfg.wms.apiKey;
  const stagingWms = !!stagingCfg.wms.baseUrl && !!stagingCfg.wms.apiKey;

  // Dernières sync (à partir du log local JSONL)
  const logPath = getProdConfig().fileLog.logPath;
  const logs = logPath ? await readJsonlLogFile(logPath, 10000) : [];
  const lastSync = computeLastSyncFromLogs(logs);

  const mk = (target: "prod" | "staging", shopify: any, byrd: boolean, wms: boolean) => ({
    connection: {
      shopify: shopify.ok
        ? { ok: true, locationName: shopify.locationName }
        : { ok: false, message: shopify.message },
      wmsConfigured: wms,
      byrdConfigured: byrd
    },
    sync: {
      lastStockSync: lastSync[target].lastStockSync,
      lastError: lastSync[target].lastError
    }
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      prod: mk("prod", prodShopify, prodByrd, prodWms),
      staging: mk("staging", stagingShopify, stagingByrd, stagingWms),
      debug: {
        logPath: logPath || null,
        logsParsed: logs.length
      }
    })
  };
};

