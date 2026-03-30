import type { Handler } from "@netlify/functions";
import {
  guardDashboardAuth,
} from "../../src/utils/dashboardAuth";
import { parseSyncTarget } from "../../src/config";
import { createStockSyncHandler } from "../../src/handlers/syncUkNetlifyHandler";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json"
};

export const handler: Handler = async (event) => {
  const authFail = guardDashboardAuth(event, CORS_HEADERS);
  if (authFail) return authFail;

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const target = parseSyncTarget(event.queryStringParameters?.target);
  const fn = createStockSyncHandler(target);
  const res = await fn(event as any, {} as any);
  return res as any;
};

