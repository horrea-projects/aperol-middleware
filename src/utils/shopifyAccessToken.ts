import fetch from "cross-fetch";
import type { AppConfig } from "../config";
import { getConfig } from "../config";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type CacheEntry = { token: string; expiresAtMs: number };

const tokenCache = new Map<string, CacheEntry>();
const pendingFetch = new Map<string, Promise<string>>();

function cacheKeyFrom(ctx: AppConfig): string {
  const { storeDomain, clientId } = ctx.shopify;
  return `${ctx.target}:${storeDomain}:${clientId}`;
}

/** Vide le cache pour ce shop (ex. après 401 : jeton OAuth périmé ou instance incohérente). */
export function invalidateShopifyAccessTokenCache(ctx: AppConfig): void {
  const k = cacheKeyFrom(ctx);
  tokenCache.delete(k);
  pendingFetch.delete(k);
}

/**
 * Token Admin API pour le contexte `ctx` (défaut : `getConfig()` appelé **une fois** au début).
 * Passer explicitement `ctx` depuis le call-site évite de rappeler `getConfig()` après un `await` quand
 * AsyncLocalStorage ne se propage pas (ex. certaines chaînes fetch sous netlify dev + esbuild).
 *
 * — Si `*_ADMIN_ACCESS_TOKEN` est défini : renvoyé tel quel (app admin boutique / legacy).
 * — Sinon : OAuth `client_credentials` (Dev Dashboard), mis en cache ~24 h avec marge avant expiration.
 */
export async function getShopifyAdminAccessToken(ctx: AppConfig = getConfig()): Promise<string> {
  const cfg = ctx.shopify;
  if (cfg.adminToken) return cfg.adminToken.trim();

  const { storeDomain, clientId, clientSecret } = cfg;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Shopify: définir PROD_SHOPIFY_ADMIN_ACCESS_TOKEN (ou SHOPIFY_*) ou bien PROD_SHOPIFY_CLIENT_ID + PROD_SHOPIFY_CLIENT_SECRET",
    );
  }

  const key = cacheKeyFrom(ctx);
  const now = Date.now();
  const hit = tokenCache.get(key);
  if (hit && now < hit.expiresAtMs - REFRESH_MARGIN_MS) {
    return hit.token.trim();
  }

  const wait = pendingFetch.get(key);
  if (wait) return wait;

  const p = (async () => {
    try {
      const url = `https://${storeDomain}/admin/oauth/access_token`;
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      });
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "aperol-middleware-uk/1.0",
        },
        body: body.toString(),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!resp.ok || data.error) {
        throw new Error(
          `Shopify client_credentials HTTP ${resp.status}: ${JSON.stringify(data)}`,
        );
      }
      const token = data.access_token;
      if (!token) {
        throw new Error("Shopify client_credentials: pas d'access_token dans la réponse");
      }
      const expiresInSec = Number(data.expires_in);
      const ttlMs = (Number.isFinite(expiresInSec) ? expiresInSec : 86399) * 1000;
      const cleaned = String(token).trim();
      tokenCache.set(key, { token: cleaned, expiresAtMs: now + ttlMs });
      return cleaned;
    } finally {
      pendingFetch.delete(key);
    }
  })();

  pendingFetch.set(key, p);
  return p;
}
