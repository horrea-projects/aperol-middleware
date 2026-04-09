import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeSku } from "./utils/skuNormalize";

/** URL de base API Byrd (prod). Construite ainsi pour ne pas dupliquer une chaîne unique repérée par le scan Netlify. */
const BYRD_BASE = "https://" + ["api", "getbyrd", "com"].join(".");

/** Première variable définie et non vide (permet le repli SHOPIFY_* historique). */
function envFirst(...keys: string[]): string {
  for (const key of keys) {
    const v = process.env[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * Même règle que `resolveShopifyStaticAdminToken` (scripts) :
 * si OAuth prod est configuré avec `PROD_SHOPIFY_CLIENT_*` sans `PROD_SHOPIFY_ADMIN_ACCESS_TOKEN`,
 * ne pas utiliser `SHOPIFY_ADMIN_ACCESS_TOKEN` (export shell obsolète sous `netlify dev`).
 */
function prodShopifyAdminTokenFromEnv(): string {
  const prodAdminRaw = (process.env.PROD_SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim();
  if (prodAdminRaw) return prodAdminRaw;

  const prodId = (process.env.PROD_SHOPIFY_CLIENT_ID ?? "").trim();
  const prodSecret = (process.env.PROD_SHOPIFY_CLIENT_SECRET ?? "").trim();
  if (prodId && prodSecret) return "";

  return envFirst("SHOPIFY_ADMIN_ACCESS_TOKEN");
}

/** Staging : token statique ou vide si OAuth STAGING_* complet (pas de repli croisé prod). */
function stagingShopifyAdminTokenFromEnv(): string {
  const direct = (process.env.STAGING_SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim();
  if (direct) return direct;
  const id = (process.env.STAGING_SHOPIFY_CLIENT_ID ?? "").trim();
  const sec = (process.env.STAGING_SHOPIFY_CLIENT_SECRET ?? "").trim();
  if (id && sec) return "";
  return "";
}

export type SyncTarget = "prod" | "staging";

/** Message court pour une 401 Shopify (token / domaine à revoir côté .env). */
export function shopifyAdminAuthEnvHint(target: SyncTarget): string {
  if (target === "staging") {
    return "Vérifier STAGING_SHOPIFY_STORE_DOMAIN + soit STAGING_SHOPIFY_ADMIN_ACCESS_TOKEN soit (STAGING_SHOPIFY_CLIENT_ID + STAGING_SHOPIFY_CLIENT_SECRET avec app installée sur cette boutique).";
  }
  return "Vérifier PROD_SHOPIFY_STORE_DOMAIN + soit PROD_SHOPIFY_ADMIN_ACCESS_TOKEN soit (PROD_SHOPIFY_CLIENT_ID + PROD_SHOPIFY_CLIENT_SECRET) — app Dev Dashboard installée sur cette boutique, secret non révoqué.";
}

/** True si Shopify est utilisable : domaine, location UK, et (token statique OU client_id+secret pour client_credentials). */
export function shopifyAuthConfigured(config: AppConfig): boolean {
  const s = config.shopify;
  if (!s.storeDomain || !s.ukLocationId) return false;
  if (s.adminToken) return true;
  return Boolean(s.clientId && s.clientSecret);
}

export function looksLikeShopifyUnauthorizedError(message: string): boolean {
  return /401|Invalid API key|Unauthorized|wrong password/i.test(message);
}

/** Domaine boutique prod affiché côté dashboard (sans secret). */
export function prodShopifyStoreDomainPublic(): string {
  return envFirst("PROD_SHOPIFY_STORE_DOMAIN", "SHOPIFY_STORE_DOMAIN");
}

/** Domaine boutique staging affiché côté dashboard. */
export function stagingShopifyStoreDomainPublic(): string {
  return (process.env.STAGING_SHOPIFY_STORE_DOMAIN ?? "").trim();
}

/** Aperçu non secret pour diagnostic (`shopify-config-snapshot` Netlify). */
export interface ShopifyConfigSnapshot {
  target: SyncTarget;
  storeDomain: string;
  ukLocationIdLength: number;
  authMode: "static_admin_token" | "client_credentials" | "incomplete";
  adminTokenLength: number;
  adminTokenPrefix6: string | null;
  clientIdLength: number;
  clientIdPrefix8: string | null;
  clientSecretLength: number;
  /**
   * `true` si `SHOPIFY_ADMIN_ACCESS_TOKEN` est défini dans process.env mais ignoré
   * car OAuth prod (`PROD_*` client id + secret) est actif sans `PROD_SHOPIFY_ADMIN_ACCESS_TOKEN`.
   */
  shellShopifyAdminIgnoredForProd: boolean;
  /**
   * Variables **encore non vides** dans `process.env` qui peuvent fournir le jeton admin statique.
   * Si ton `.env` ne les définit plus mais qu’elles apparaissent ici : shell, `.env` ailleurs,
   * ou variables **Netlify** réinjectées par `netlify dev` (site lié).
   */
  adminTokenProcessEnvKeysNonEmpty: string[];
}

export interface AppConfig {
  target: SyncTarget;
  shopify: {
    storeDomain: string;
    /** Token admin statique (app créée dans la boutique) ; vide si auth par client_credentials. */
    adminToken: string;
    /** Dev Dashboard : utilisés pour obtenir un access_token ~24 h (rafraîchi automatiquement par le middleware). */
    clientId: string;
    clientSecret: string;
    ukLocationId: string;
  };
  byrd: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    warehouseId: string;
  };
  wms: {
    baseUrl: string;
    apiKey: string;
  };
  slack: {
    webhookUrl: string;
  };
  fileLog: {
    logPath: string;
  };
  sync: {
    excludedSkus: Set<string>;
  };
}

const configAls = new AsyncLocalStorage<AppConfig>();

/**
 * Exécute une fonction avec une config prod/staging dans AsyncLocalStorage.
 * Plusieurs `runWithConfig` en parallèle (ex. prod + staging) restent isolés :
 * ne pas utiliser de pile globale comme repli de `getConfig()`, sinon après un `await`
 * les requêtes mélangent domaine, credentials et location entre les deux cibles.
 */
export function runWithConfig<T>(config: AppConfig, fn: () => Promise<T>): Promise<T> {
  return configAls.run(config, () => fn());
}

export function getConfig(): AppConfig {
  const c = configAls.getStore();
  if (!c) {
    throw new Error("Configuration middleware non initialisée (contexte requête absent)");
  }
  return c;
}

/** Config production sans ALS (logs fichier hors handler, scripts locaux). */
export function getProdConfig(): AppConfig {
  return buildConfig("prod");
}

export function buildConfig(target: SyncTarget): AppConfig {
  const excludedSkusRaw =
    target === "staging"
      ? (process.env.STAGING_SYNC_EXCLUDED_SKUS ?? "").trim()
      : (process.env.PROD_SYNC_EXCLUDED_SKUS ?? process.env.SYNC_EXCLUDED_SKUS ?? "").trim();
  const excludedSkus = new Set(
    excludedSkusRaw
      .split(",")
      .map((s) => normalizeSku(s))
      .filter((s) => s !== ""),
  );

  const shopify =
    target === "staging"
      ? {
          storeDomain: (process.env.STAGING_SHOPIFY_STORE_DOMAIN ?? "").trim(),
          adminToken: stagingShopifyAdminTokenFromEnv(),
          clientId: (process.env.STAGING_SHOPIFY_CLIENT_ID ?? "").trim(),
          clientSecret: (process.env.STAGING_SHOPIFY_CLIENT_SECRET ?? "").trim(),
          ukLocationId: (process.env.STAGING_SHOPIFY_UK_LOCATION_ID ?? "").trim()
        }
      : {
          storeDomain: envFirst("PROD_SHOPIFY_STORE_DOMAIN", "SHOPIFY_STORE_DOMAIN"),
          adminToken: prodShopifyAdminTokenFromEnv(),
          clientId: envFirst("PROD_SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_ID"),
          clientSecret: envFirst("PROD_SHOPIFY_CLIENT_SECRET", "SHOPIFY_CLIENT_SECRET"),
          ukLocationId: envFirst("PROD_SHOPIFY_UK_LOCATION_ID", "SHOPIFY_UK_LOCATION_ID")
        };

  const stagingUsesOwnByrd =
    target === "staging" &&
    !!(process.env.STAGING_BYRD_API_KEY && process.env.STAGING_BYRD_API_SECRET);

  const byrd = stagingUsesOwnByrd
    ? {
        baseUrl: process.env.STAGING_BYRD_BASE_URL ?? process.env.BYRD_BASE_URL ?? BYRD_BASE,
        apiKey: process.env.STAGING_BYRD_API_KEY ?? "",
        apiSecret: process.env.STAGING_BYRD_API_SECRET ?? "",
        warehouseId:
          process.env.STAGING_BYRD_WAREHOUSE_ID ?? process.env.BYRD_WAREHOUSE_ID ?? ""
      }
    : {
        baseUrl: process.env.BYRD_BASE_URL ?? BYRD_BASE,
        apiKey: process.env.BYRD_API_KEY ?? "",
        apiSecret: process.env.BYRD_API_SECRET ?? "",
        warehouseId: process.env.BYRD_WAREHOUSE_ID ?? ""
      };

  const stagingUsesOwnWms =
    target === "staging" &&
    !!(process.env.STAGING_WMS_BASE_URL && process.env.STAGING_WMS_API_KEY);

  const wms = stagingUsesOwnWms
    ? {
        baseUrl: process.env.STAGING_WMS_BASE_URL ?? "",
        apiKey: process.env.STAGING_WMS_API_KEY ?? ""
      }
    : {
        baseUrl: process.env.WMS_BASE_URL ?? "",
        apiKey: process.env.WMS_API_KEY ?? ""
      };

  const slackWebhook =
    target === "staging"
      ? (() => {
          const st = (process.env.STAGING_SLACK_WEBHOOK_URL ?? "").trim();
          return st || (process.env.SLACK_WEBHOOK_URL ?? "").trim();
        })()
      : (process.env.SLACK_WEBHOOK_URL ?? "").trim();

  return {
    target,
    shopify,
    byrd,
    wms,
    slack: {
      webhookUrl: slackWebhook
    },
    fileLog: {
      logPath: process.env.LOG_FILE_PATH ?? "." + "/middleware.log"
    },
    sync: {
      excludedSkus,
    },
  };
}

export function assertConfig(config: AppConfig): void {
  const s = config.shopify;
  const hasToken = !!s.adminToken;
  const hasClientCreds = !!s.clientId && !!s.clientSecret;
  if (!s.storeDomain || !s.ukLocationId || (!hasToken && !hasClientCreds)) {
    const hint =
      config.target === "staging"
        ? "STAGING_SHOPIFY_STORE_DOMAIN, STAGING_SHOPIFY_UK_LOCATION_ID, et soit STAGING_SHOPIFY_ADMIN_ACCESS_TOKEN soit STAGING_SHOPIFY_CLIENT_ID + STAGING_SHOPIFY_CLIENT_SECRET"
        : "PROD_SHOPIFY_STORE_DOMAIN, PROD_SHOPIFY_UK_LOCATION_ID, et soit PROD_SHOPIFY_ADMIN_ACCESS_TOKEN soit PROD_SHOPIFY_CLIENT_ID + PROD_SHOPIFY_CLIENT_SECRET (repli SHOPIFY_*)";
    throw new Error(`Shopify (${config.target}) incomplet — renseigner ${hint}`);
  }
  const useByrd = !!config.byrd.apiKey && !!config.byrd.apiSecret;
  const useWms = !!config.wms.baseUrl && !!config.wms.apiKey;
  if (!useByrd && !useWms) {
    throw new Error(
      "Configurer soit Byrd (clés API) soit WMS (WMS_BASE_URL, WMS_API_KEY) pour cet environnement"
    );
  }
}

export function parseSyncTarget(raw: string | undefined): SyncTarget {
  const v = (raw || "prod").toLowerCase();
  if (v === "staging") return "staging";
  return "prod";
}

function adminTokenProcessEnvKeysNonEmpty(target: SyncTarget): string[] {
  if (target === "staging") {
    return ["STAGING_SHOPIFY_ADMIN_ACCESS_TOKEN"].filter((k) =>
      Boolean((process.env[k] ?? "").trim()),
    );
  }
  return ["PROD_SHOPIFY_ADMIN_ACCESS_TOKEN", "SHOPIFY_ADMIN_ACCESS_TOKEN"].filter((k) =>
    Boolean((process.env[k] ?? "").trim()),
  );
}

export function shopifyConfigSnapshot(target: SyncTarget): ShopifyConfigSnapshot {
  const c = buildConfig(target);
  const s = c.shopify;
  const hasStatic = Boolean(s.adminToken);
  const hasOAuth = Boolean(s.clientId && s.clientSecret);
  let authMode: ShopifyConfigSnapshot["authMode"] = "incomplete";
  if (hasStatic) authMode = "static_admin_token";
  else if (hasOAuth) authMode = "client_credentials";

  const shellIgnored =
    target === "prod" &&
    Boolean((process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim()) &&
    !Boolean((process.env.PROD_SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim()) &&
    Boolean((process.env.PROD_SHOPIFY_CLIENT_ID ?? "").trim()) &&
    Boolean((process.env.PROD_SHOPIFY_CLIENT_SECRET ?? "").trim());

  return {
    target,
    storeDomain: s.storeDomain,
    ukLocationIdLength: s.ukLocationId.length,
    authMode,
    adminTokenLength: s.adminToken.length,
    adminTokenPrefix6: s.adminToken ? `${s.adminToken.slice(0, 6)}…` : null,
    clientIdLength: s.clientId.length,
    clientIdPrefix8: s.clientId ? `${s.clientId.slice(0, 8)}…` : null,
    clientSecretLength: s.clientSecret.length,
    shellShopifyAdminIgnoredForProd: shellIgnored,
    adminTokenProcessEnvKeysNonEmpty: adminTokenProcessEnvKeysNonEmpty(target),
  };
}
