import type { Handler } from "@netlify/functions";
import {
  prodShopifyStoreDomainPublic,
  stagingShopifyStoreDomainPublic
} from "../../src/config";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
  "Cache-Control": "private, no-store, must-revalidate"
};

/**
 * Métadonnées non secrètes pour le dashboard (noms de domaine Shopify par cible).
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  const authFail = guardDashboardAuth(event, CORS_HEADERS);
  if (authFail) return authFail;
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
      prod: {
        label: "Production",
        shopDomain: prodShopifyStoreDomainPublic() || null
      },
      staging: {
        label: "Staging",
        shopDomain: stagingShopifyStoreDomainPublic() || null
      }
    })
  };
};
