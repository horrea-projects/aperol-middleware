/**
 * Client pour l’API Byrd (documentation: https://developers.getbyrd.com/docs/getting-product-details).
 * Auth: JWT via POST /v2/login (username=apiKey, password=apiSecret).
 * Limite: 5 appels/min sur /v2/login — on met en cache le token par couple (baseUrl, apiKey).
 */

import { getConfig } from "../config";
import { httpRequest } from "../utils/http";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_BUFFER_SECONDS = 60;

function tokenCacheKey(): string {
  const c = getConfig().byrd;
  return `${c.baseUrl}|${c.apiKey}`;
}

async function getToken(): Promise<string> {
  const key = tokenCacheKey();
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() / 1000 + TOKEN_BUFFER_SECONDS) {
    return cached.token;
  }
  const cfg = getConfig().byrd;
  const url = `${cfg.baseUrl}/v2/login`;
  const body = {
    username: cfg.apiKey,
    password: cfg.apiSecret
  };
  const res = await httpRequest<{ token: string; payload?: { exp: number } }>(url, {
    method: "POST",
    body,
    retryCount: 2
  });
  const exp = res.payload?.exp ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  tokenCache.set(key, { token: res.token, expiresAt: exp });
  return res.token;
}

export interface ByrdProduct {
  id: string;
  sku: string;
  name?: string;
  stocksByWarehouse: Record<string, { available: number; physical?: number; reserved?: number; unavailable?: number }>;
}

async function byrdRequest<T>(path: string, options: { method?: string; params?: Record<string, string> } = {}): Promise<T> {
  const token = await getToken();
  const base = getConfig().byrd.baseUrl.replace(/\/$/, "");
  const url = new URL(path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`);
  if (options.params) {
    Object.entries(options.params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  return httpRequest<T>(url.toString(), {
    method: (options.method as "GET" | "POST") || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "aperol-middleware-uk/1.0"
    },
    retryCount: 2
  });
}

/** Liste les produits avec stock par entrepôt (pagination 250 par page). */
export async function listByrdProducts(): Promise<ByrdProduct[]> {
  const out: ByrdProduct[] = [];
  let page = 0;
  const perPage = 250;
  for (;;) {
    const params: Record<string, string> = { per_page: String(perPage), page: String(page) };
    const data = await byrdRequest<{ data?: ByrdProduct[]; last_page?: boolean }>(
      "/v2/warehouse/products",
      { params }
    );
    const list = (data as { data?: ByrdProduct[] }).data ?? [];
    if (!list.length) break;
    out.push(...list);
    const lastPage = (data as { last_page?: boolean }).last_page ?? false;
    if (lastPage || list.length < perPage) break;
    page++;
  }
  return out;
}

/** Récupère le stock (available) pour un SKU précis, côté entrepôt UK (BYRD_WAREHOUSE_ID). */
export async function fetchByrdStockForSku(sku: string): Promise<Pick<ByrdProduct, "sku"> & { quantity: number; usedWarehouseKey: string | null }> {
  const warehouseId = getConfig().byrd.warehouseId;
  // byrd supporte un filtre `sku` sur /v2/warehouse/products
  const data = await byrdRequest<{ data?: ByrdProduct[] }>(
    "/v2/warehouse/products",
    { params: { per_page: "1", page: "0", sku } }
  );
  const product = (data as { data?: ByrdProduct[] }).data?.[0];
  const stocks = product?.stocksByWarehouse ?? {};

  let usedWarehouseKey: string | null = null;
  if (warehouseId) {
    usedWarehouseKey = warehouseId;
  } else {
    const anyKey = Object.keys(stocks)[0];
    usedWarehouseKey = anyKey ?? null;
  }

  const quantity = usedWarehouseKey && (stocks as any)[usedWarehouseKey]?.available != null
    ? (stocks as any)[usedWarehouseKey].available
    : 0;

  // Sécurité: si BYRD_WAREHOUSE_ID est défini mais absent dans stocksByWarehouse,
  // on force 0 (ne pas tomber sur un autre entrepôt).
  const forcedQuantity = warehouseId ? (stocks[warehouseId]?.available ?? 0) : quantity;

  return { sku, quantity: forcedQuantity, usedWarehouseKey };
}

export function isByrdConfigured(): boolean {
  const c = getConfig().byrd;
  return !!c.apiKey && !!c.apiSecret;
}
