import type { Handler } from "@netlify/functions";
import { isDashboardAuthConfigured } from "../../src/utils/dashboardAuth";

/**
 * Sans authentification : indique seulement si DASHBOARD_PASSWORD est défini côté serveur.
 * Utile pour déboguer pourquoi le « logout » semble sans effet (auth désactivée = pas de vraie session).
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      authRequired: isDashboardAuthConfigured()
    })
  };
};
