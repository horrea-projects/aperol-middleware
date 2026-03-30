/**
 * Génère un Admin API access token pour une app Shopify issue du Dev Dashboard.
 *
 * Doc Shopify: https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
 * Endpoint: POST https://{shop}.myshopify.com/admin/oauth/access_token
 *
 * Variables selon la cible (SHOPIFY_TARGET=prod | staging, défaut prod) :
 *   Prod : PROD_SHOPIFY_* avec repli sur SHOPIFY_*
 *   Staging : STAGING_SHOPIFY_*
 *
 * Usage :
 *   node scripts/shopify_get_admin_access_token_dev_dashboard.mjs
 *   SHOPIFY_TARGET=staging node scripts/shopify_get_admin_access_token_dev_dashboard.mjs
 */

import fetch from "cross-fetch";

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

const target = (process.env.SHOPIFY_TARGET || "prod").toLowerCase();
const isStaging = target === "staging";

const storeDomain = isStaging
  ? firstNonEmpty(process.env.STAGING_SHOPIFY_STORE_DOMAIN)
  : firstNonEmpty(
      process.env.PROD_SHOPIFY_STORE_DOMAIN,
      process.env.SHOPIFY_STORE_DOMAIN
    );

const clientId = isStaging
  ? firstNonEmpty(process.env.STAGING_SHOPIFY_CLIENT_ID)
  : firstNonEmpty(
      process.env.PROD_SHOPIFY_CLIENT_ID,
      process.env.SHOPIFY_CLIENT_ID
    );

const clientSecret = isStaging
  ? firstNonEmpty(process.env.STAGING_SHOPIFY_CLIENT_SECRET)
  : firstNonEmpty(
      process.env.PROD_SHOPIFY_CLIENT_SECRET,
      process.env.SHOPIFY_CLIENT_SECRET
    );

if (!storeDomain || !clientId || !clientSecret) {
  const prefix = isStaging ? "STAGING_SHOPIFY_" : "PROD_SHOPIFY_ (ou SHOPIFY_)";
  console.error(
    `Missing env vars for ${isStaging ? "staging" : "prod"}: ${prefix}STORE_DOMAIN, *_CLIENT_ID, *_CLIENT_SECRET`
  );
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
      target: isStaging ? "staging" : "prod",
      storeDomain,
      access_token: data.access_token,
      scope: data.scope,
      expires_in: data.expires_in
    },
    null,
    2
  )
);
