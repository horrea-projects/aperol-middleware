/**
 * Génère un Admin API access token pour l'app Shopify de STAGING (Dev Dashboard).
 *
 * Entrées :
 *   STAGING_SHOPIFY_STORE_DOMAIN
 *   STAGING_SHOPIFY_CLIENT_ID
 *   STAGING_SHOPIFY_CLIENT_SECRET
 *
 * Endpoint :
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *
 * Usage :
 *   npm run shopify:get-admin-token:staging
 */

import fetch from "cross-fetch";

const storeDomain = process.env.STAGING_SHOPIFY_STORE_DOMAIN;
const clientId = process.env.STAGING_SHOPIFY_CLIENT_ID;
const clientSecret = process.env.STAGING_SHOPIFY_CLIENT_SECRET;

if (!storeDomain || !clientId || !clientSecret) {
  console.error("Missing env vars: STAGING_SHOPIFY_STORE_DOMAIN, STAGING_SHOPIFY_CLIENT_ID, STAGING_SHOPIFY_CLIENT_SECRET");
  process.exit(1);
}

const url = `https://${storeDomain}/admin/oauth/access_token`;

const body = new URLSearchParams({
  grant_type: "client_credentials",
  client_id: clientId,
  client_secret: clientSecret
}).toString();

const resp = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "aperol-middleware-uk/1.0"
  },
  body
});

const data = await resp.json().catch(() => ({}));

if (!resp.ok || data?.error) {
  console.error("Shopify OAuth token error:", JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      access_token: data.access_token,
      scope: data.scope,
      expires_in: data.expires_in
    },
    null,
    2
  )
);

