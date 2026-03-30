import type { Handler } from "@netlify/functions";
import {
  dashboardSessionClearCookieHeader,
  isDashboardAuthConfigured
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

  const multiValueHeaders = isDashboardAuthConfigured()
    ? { "Set-Cookie": [dashboardSessionClearCookieHeader(event)] }
    : undefined;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    ...(multiValueHeaders ? { multiValueHeaders } : {}),
    body: JSON.stringify({ ok: true })
  };
};
