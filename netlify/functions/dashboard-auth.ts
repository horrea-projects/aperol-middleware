import type { Handler } from "@netlify/functions";
import {
  createDashboardSessionCookieValue,
  dashboardSessionClearCookieHeader,
  dashboardSessionSetCookieHeader,
  isDashboardAuthConfigured,
  normalizeDashboardSecret
} from "../../src/utils/dashboardAuth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
  "Cache-Control": "private, no-store, must-revalidate"
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  if (!isDashboardAuthConfigured()) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      multiValueHeaders: {
        "Set-Cookie": [dashboardSessionClearCookieHeader(event)]
      },
      body: JSON.stringify({
        ok: true,
        authDisabled: true,
        message:
          "DASHBOARD_PASSWORD non défini sur le serveur : le dashboard est accessible sans login (développement uniquement)."
      })
    };
  }

  let body: { password?: string } = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    /* ignore */
  }
  const given = normalizeDashboardSecret(String(body.password ?? ""));
  const expected = normalizeDashboardSecret(process.env.DASHBOARD_PASSWORD ?? "");
  if (!given || given !== expected) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: false, error: "invalid_password" })
    };
  }

  try {
    const session = createDashboardSessionCookieValue();
    if (
      process.env.DASHBOARD_DEBUG === "1" ||
      process.env.DASHBOARD_DEBUG === "true"
    ) {
      console.warn("[dashboard-auth] login ok, setting session cookie (multiValueHeaders)");
    }
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      multiValueHeaders: {
        "Set-Cookie": [dashboardSessionSetCookieHeader(event, session)]
      },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: String(err) })
    };
  }
};
