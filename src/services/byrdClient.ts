/**
 * Client pour l’API Byrd (documentation: https://developers.getbyrd.com/docs/getting-product-details).
 * Auth: JWT via POST /v2/login (username=apiKey, password=apiSecret).
 * Limite: 5 appels/min sur /v2/login — on met en cache le token.
 */

import { CONFIG } from "../config";
import { httpRequest } from "../utils/http";

let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_BUFFER_SECONDS = 60;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() / 1000 + TOKEN_BUFFER_SECONDS) {
    return cachedToken.token;
  }
  const url = `${CONFIG.byrd.baseUrl}/v2/login`;
  const body = {
    username: CONFIG.byrd.apiKey,
    password: CONFIG.byrd.apiSecret
  };
  const res = await httpRequest<{ token: string; payload?: { exp: number } }>(url, {
    method: "POST",
    body,
    retryCount: 2
  });
  const exp = res.payload?.exp ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  cachedToken = { token: res.token, expiresAt: exp };
  return res.token;
}

export interface ByrdProduct {
  id: string;
  sku: string;
  name?: string;
  stocksByWarehouse: Record<string, { available: number; physical?: number; reserved?: number; unavailable?: number }>;
}

export interface ByrdShipment {
  id: string;
  status: string;
  updated_at: string;
  shop?: { order_id?: string; order_number?: string };
  warehouse?: { id?: string; code?: string };
  checkpoints?: { sent_at?: string | null; packaged_at?: string | null };
  units?: Array<{
    carrier?: { tracking_number?: string; name?: string };
  }>;
}

async function byrdRequest<T>(path: string, options: { method?: string; params?: Record<string, string> } = {}): Promise<T> {
  const token = await getToken();
  const base = CONFIG.byrd.baseUrl.replace(/\/$/, "");
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

/** Liste les expéditions mises à jour depuis une date (API v3). */
export async function listByrdShipments(params: {
  dateFrom: string;
  dateField?: string;
  warehouseId?: string;
  status?: string[];
}): Promise<ByrdShipment[]> {
  const q: Record<string, string> = {
    date_field: params.dateField ?? "updated_at",
    date_from: params.dateFrom,
    per_page: "250",
    page: "0"
  };
  if (params.status?.length) q.status = params.status.join(",");
  const res = await byrdRequest<{ data?: ByrdShipment[]; last_page?: boolean }>("/v3/shipments", {
    params: q
  });
  const list = (res as { data?: ByrdShipment[] }).data ?? [];
  let filtered = list;
  if (params.warehouseId) {
    filtered = list.filter((s) => s.warehouse?.id === params.warehouseId || s.warehouse?.code === params.warehouseId);
  }
  return filtered;
}

export function isByrdConfigured(): boolean {
  return !!CONFIG.byrd.apiKey && !!CONFIG.byrd.apiSecret;
}
