import type { Handler } from "@netlify/functions";
import fetch from "cross-fetch";
import {
  buildConfig,
  runWithConfig,
  shopifyConfigSnapshot,
  type SyncTarget,
} from "../../src/config";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import {
  getShopifyAdminAccessToken,
  invalidateShopifyAccessTokenCache,
} from "../../src/utils/shopifyAccessToken";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json",
};

async function probeOAuth(
  storeDomain: string,
  clientId: string,
  clientSecret: string,
) {
  if (!storeDomain || !clientId || !clientSecret) {
    return { skipped: true as const, reason: "missing_domain_or_client" };
  }
  const url = `https://${storeDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    skipped: false as const,
    httpStatus: resp.status,
    ok: resp.ok,
    oauthError: data.error ?? null,
    errorDescription: data.error_description ?? null,
    expiresIn: data.expires_in ?? null,
    hasAccessToken: Boolean(data.access_token),
  };
}

async function probeGraphql(target: SyncTarget) {
  const cfg = buildConfig(target);
  return runWithConfig(cfg, async () => {
    invalidateShopifyAccessTokenCache(cfg);
    const token = await getShopifyAdminAccessToken(cfg);
    const url = `https://${cfg.shopify.storeDomain}/admin/api/2024-10/graphql.json`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": String(token).trim(),
      },
      body: JSON.stringify({ query: "{ shop { name } }" }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      errors?: unknown;
      data?: { shop?: { name?: string } };
    };
    return {
      httpStatus: resp.status,
      ok: resp.ok,
      graphqlErrors: data.errors ?? null,
      shopName: data.data?.shop?.name ?? null,
      tokenPrefix8: token ? `${String(token).slice(0, 8)}…` : null,
    };
  });
}

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
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const pCfg = buildConfig("prod");
  const sCfg = buildConfig("staging");

  const prodOauth = await probeOAuth(
    pCfg.shopify.storeDomain,
    pCfg.shopify.clientId,
    pCfg.shopify.clientSecret,
  );
  const stagingOauth = await probeOAuth(
    sCfg.shopify.storeDomain,
    sCfg.shopify.clientId,
    sCfg.shopify.clientSecret,
  );

  const prodG = await probeGraphql("prod");
  const stagingG = await probeGraphql("staging");

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      note:
        "Même runtime que les autres fonctions. Si shopify:auth-check OK mais graphql 401 ici : en général env incomplet sous netlify dev (clientSecretLength: 0) ou ancien bundle — redémarrer `npm run dev`.",
      prod: {
        snapshot: shopifyConfigSnapshot("prod"),
        oauth: prodOauth,
        graphql: prodG,
      },
      staging: {
        snapshot: shopifyConfigSnapshot("staging"),
        oauth: stagingOauth,
        graphql: stagingG,
      },
    }),
  };
};
