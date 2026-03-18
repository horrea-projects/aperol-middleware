const BYRD_BASE = "https://api.getbyrd.com";

export const CONFIG = {
  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN ?? "",
    adminToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "",
    ukLocationId: process.env.SHOPIFY_UK_LOCATION_ID ?? ""
  },
  /** API Byrd (WMS) – auth JWT via POST /v2/login avec apiKey/apiSecret */
  byrd: {
    baseUrl: process.env.BYRD_BASE_URL ?? BYRD_BASE,
    apiKey: process.env.BYRD_API_KEY ?? "",
    apiSecret: process.env.BYRD_API_SECRET ?? "",
    /** ID de l’entrepôt UK dans Byrd (optionnel si un seul entrepôt) */
    warehouseId: process.env.BYRD_WAREHOUSE_ID ?? ""
  },
  /** Rétrocompat: WMS générique (laissé vide si on utilise Byrd) */
  wms: {
    baseUrl: process.env.WMS_BASE_URL ?? "",
    apiKey: process.env.WMS_API_KEY ?? ""
  },
  redis: {
    restUrl: process.env.REDIS_REST_URL ?? "",
    restToken: process.env.REDIS_REST_TOKEN ?? "",
    enabled: !!process.env.REDIS_REST_URL && !!process.env.REDIS_REST_TOKEN
  },
  sync: {
    shipmentWindowMinutes: Number(process.env.SHIPMENT_WINDOW_MINUTES ?? "120")
  }
};

export function assertConfig() {
  if (!CONFIG.shopify.storeDomain || !CONFIG.shopify.adminToken || !CONFIG.shopify.ukLocationId) {
    throw new Error("Shopify configuration manquante (SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, SHOPIFY_UK_LOCATION_ID)");
  }
  const useByrd = !!CONFIG.byrd.apiKey && !!CONFIG.byrd.apiSecret;
  const useWms = !!CONFIG.wms.baseUrl && !!CONFIG.wms.apiKey;
  if (!useByrd && !useWms) {
    throw new Error("Configurer soit Byrd (BYRD_API_KEY, BYRD_API_SECRET) soit WMS (WMS_BASE_URL, WMS_API_KEY)");
  }
}

