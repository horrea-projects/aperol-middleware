import type { Handler } from "@netlify/functions";
import { parseSyncTarget } from "../../src/config";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import { deleteSyncRun, listSyncRuns } from "../../src/utils/syncRunHistory";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json"
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  const authFail = guardDashboardAuth(event, CORS_HEADERS);
  if (authFail) return authFail;

  if (event.httpMethod === "GET") {
    const limit = Math.min(Number(event.queryStringParameters?.limit) || 80, 200);
    const rawTarget = event.queryStringParameters?.target;
    const target =
      rawTarget === "all" ? "all" : parseSyncTarget(rawTarget ?? undefined);
    try {
      const runs = await listSyncRuns({ limit, target });
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ runs })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: String(err) })
      };
    }
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id?.trim();
    if (!id) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing id" })
      };
    }
    try {
      const deleted = await deleteSyncRun(id);
      return {
        statusCode: deleted ? 200 : 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ deleted })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: String(err) })
      };
    }
  }

  return {
    statusCode: 405,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: "Method not allowed" })
  };
};
