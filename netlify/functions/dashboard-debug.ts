import type { Handler, HandlerResponse } from "@netlify/functions";
import {
  DASHBOARD_SESSION_COOKIE,
  dashboardAuthDebugEnabled,
  isDashboardAuthConfigured,
  readDashboardSessionCookie,
  verifyDashboardToken
} from "../../src/utils/dashboardAuth";

/**
 * Diagnostic session cookie (dev uniquement). Active avec DASHBOARD_DEBUG=1 sur Netlify / .env local.
 * GET /.netlify/functions/dashboard-debug
 */
export const handler: Handler = async (event): Promise<HandlerResponse> => {
  if (!dashboardAuthDebugEnabled()) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Not found"
    };
  }
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: ""
    };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const raw = String(
    event.headers?.cookie || event.headers?.Cookie || ""
  );
  const session = readDashboardSessionCookie(event);
  const sessionValid = Boolean(session && verifyDashboardToken(session));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authConfigured: isDashboardAuthConfigured(),
      host: event.headers?.host ?? null,
      forwardedProto:
        event.headers?.["x-forwarded-proto"] ||
        event.headers?.["X-Forwarded-Proto"] ||
        null,
      cookieHeaderLength: raw.length,
      hasCookieName: raw.includes(DASHBOARD_SESSION_COOKIE + "="),
      sessionValueLength: session.length,
      sessionValid
    })
  };
};
