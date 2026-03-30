/**
 * Valide l'auth Shopify Admin API et affiche shop, app installation ID, scopes.
 *
 * Le fichier `.env` pilote la logique : s’il contient un `CLIENT_ID` mais **aucune** ligne
 * `*_ADMIN_ACCESS_TOKEN`, un jeton exporté dans le shell est **ignoré** (mode
 * `client_credentials` uniquement).
 *
 * SHOPIFY_TARGET=prod | staging (défaut prod)
 *
 * Usage :
 *   node scripts/shopify_auth_check.mjs
 *   SHOPIFY_TARGET=staging node scripts/shopify_auth_check.mjs
 */

import fetch from "cross-fetch";
import {
  envFirstFromFileThenProcess,
  loadDotEnvFile,
  resolveShopifyStaticAdminToken,
} from "./load_dotenv.mjs";

const fileEnv = loadDotEnvFile();

const target = (process.env.SHOPIFY_TARGET || "prod").toLowerCase();
const isStaging = target === "staging";

const storeDomain = isStaging
  ? envFirstFromFileThenProcess(fileEnv, "STAGING_SHOPIFY_STORE_DOMAIN")
  : envFirstFromFileThenProcess(
      fileEnv,
      "PROD_SHOPIFY_STORE_DOMAIN",
      "SHOPIFY_STORE_DOMAIN",
    );

let token = resolveShopifyStaticAdminToken(fileEnv, isStaging);

const clientId = isStaging
  ? envFirstFromFileThenProcess(fileEnv, "STAGING_SHOPIFY_CLIENT_ID")
  : envFirstFromFileThenProcess(
      fileEnv,
      "PROD_SHOPIFY_CLIENT_ID",
      "SHOPIFY_CLIENT_ID",
    );

const clientSecret = isStaging
  ? envFirstFromFileThenProcess(fileEnv, "STAGING_SHOPIFY_CLIENT_SECRET")
  : envFirstFromFileThenProcess(
      fileEnv,
      "PROD_SHOPIFY_CLIENT_SECRET",
      "SHOPIFY_CLIENT_SECRET",
    );

if (!storeDomain || (!token && (!clientId || !clientSecret))) {
  const hint = isStaging
    ? "STAGING_SHOPIFY_STORE_DOMAIN + token ou CLIENT_ID+SECRET"
    : "PROD_SHOPIFY_STORE_DOMAIN + ADMIN_ACCESS_TOKEN (ou SHOPIFY_*) ou CLIENT_ID+SECRET";
  console.error(`Missing env for ${isStaging ? "staging" : "prod"}: ${hint}`);
  process.exit(1);
}

let authVia = token ? "static_admin_token" : null;

if (!token && clientId && clientSecret) {
  const url = `https://${storeDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tr = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const td = await tr.json().catch(() => ({}));
  if (!tr.ok || td.error) {
    console.error("client_credentials failed:", JSON.stringify(td, null, 2));
    process.exit(1);
  }
  token = td.access_token;
  if (!token) {
    console.error("No access_token in response", td);
    process.exit(1);
  }
  authVia = "client_credentials";
  console.error(
    "(token obtenu via client_credentials, expires_in:",
    td.expires_in,
    ")\n",
  );
}

console.error("(auth:", authVia, "| shop:", storeDomain, ")\n");

const endpoint = `https://${storeDomain}/admin/api/2024-10/graphql.json`;

const query = `
  query AppCheck {
    shop { name myshopifyDomain }
    appInstallation {
      id
      accessScopes { handle }
    }
  }
`;

const resp = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": String(token).trim(),
  },
  body: JSON.stringify({ query }),
});

const data = await resp.json();

if (!resp.ok || data.errors) {
  console.error("Shopify API error:", JSON.stringify(data, null, 2));
  if (resp.status === 401 || String(JSON.stringify(data)).includes("Invalid API key")) {
    console.error(
      "\n→ 401 : jeton refusé pour cette boutique (auth utilisée : " + authVia + ").",
    );
    if (authVia === "static_admin_token") {
      console.error(
        "   Régénère ou supprime la variable *_ADMIN_ACCESS_TOKEN dans .env et utilise CLIENT_ID+SECRET si app Dev Dashboard.",
      );
    } else {
      console.error(
        "   Vérifie CLIENT_ID / CLIENT_SECRET (Dev Dashboard), app installée sur ce shop, et absence d’un export shell obsolète (unset SHOPIFY_ADMIN_ACCESS_TOKEN).",
      );
    }
  }
  process.exit(1);
}

const scopes = (data.data?.appInstallation?.accessScopes ?? [])
  .map((s) => s.handle)
  .sort();
console.log(
  JSON.stringify(
    {
      target: isStaging ? "staging" : "prod",
      storeDomain,
      shop: data.data.shop,
      appInstallationId: data.data.appInstallation.id,
      accessScopes: scopes,
    },
    null,
    2,
  ),
);
