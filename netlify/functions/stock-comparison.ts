import type { Handler } from "@netlify/functions";
import {
  assertConfig,
  buildConfig,
  getConfig,
  looksLikeShopifyUnauthorizedError,
  parseSyncTarget,
  runWithConfig,
  shopifyAdminAuthEnvHint,
  shopifyAuthConfigured
} from "../../src/config";
import { ShopifyService, type StockLevelItem } from "../../src/services/shopifyService";
import { listByrdProducts, isByrdConfigured } from "../../src/services/byrdClient";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import {
  aggregateProductKindForSku,
  groupShopifyLevelsByNormalizedSku,
  mergeQuantitiesBySku,
  shortShopifyInventoryItemGid
} from "../../src/utils/skuNormalize";

function countCommonSkus(
  byrdKeys: Iterable<string>,
  shopifyKeys: Iterable<string>
): number {
  const s = new Set(shopifyKeys);
  let n = 0;
  for (const k of byrdKeys) {
    if (s.has(k)) n += 1;
  }
  return n;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json"
};

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

  const target = parseSyncTarget(event.queryStringParameters?.target);
  const config = buildConfig(target);
  try {
    assertConfig(config);
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "config_incomplete",
        target,
        message: String(err)
      })
    };
  }

  return runWithConfig(config, async () => {
    const byrdStock: { sku: string; quantity: number; name?: string }[] = [];
    let shopifyStock: StockLevelItem[] = [];
    let locationName = "Shopify UK";

    try {
      if (isByrdConfigured()) {
        const products = await listByrdProducts();
        const wid = getConfig().byrd.warehouseId;
        for (const p of products) {
          const stocks = p.stocksByWarehouse ?? {};
          let qty = 0;
          if (wid) {
            qty = stocks[wid]?.available ?? 0;
          } else {
            const anyKey = Object.keys(stocks)[0];
            qty = anyKey ? (stocks[anyKey]?.available ?? 0) : 0;
          }
          if (p.sku) byrdStock.push({ sku: p.sku, quantity: qty, name: p.name });
        }
      }
    } catch (err) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "byrd_fetch_failed",
          message: String(err),
          target,
          byrd: [],
          locationName,
          shopify: [],
          comparison: [],
          stats: {
            byrdProductCount: 0,
            byrdUniqueSkuCount: 0,
            shopifyInventoryItemCount: 0,
            shopifyUniqueSkuCount: 0,
            commonSkuCount: 0
          }
        })
      };
    }

    try {
      if (shopifyAuthConfigured(getConfig())) {
        const shopify = new ShopifyService();
        locationName = await shopify.fetchUkLocationName();
        shopifyStock = await shopify.fetchInventoryLevelsForUkLocation();
      }
    } catch (err) {
      const message = String(err);
      const byrdMapPartial = mergeQuantitiesBySku(
        byrdStock.map((b) => ({ sku: b.sku, quantity: b.quantity }))
      );
      const payload: Record<string, unknown> = {
        error: "shopify_fetch_failed",
        message,
        target,
        byrd: byrdStock,
        locationName,
        shopify: [],
        comparison: byrdStock.map((b) => ({
          sku: b.sku,
          byrd: b.quantity,
          shopify: null,
          match: false,
          shopifyInventoryItemCount: 0,
          shopifyInventoryItems: [] as { inventoryItemGid: string; inventoryItemNumericId: string }[]
        })),
        stats: {
          byrdProductCount: byrdStock.length,
          byrdUniqueSkuCount: byrdMapPartial.size,
          shopifyInventoryItemCount: 0,
          shopifyUniqueSkuCount: 0,
          commonSkuCount: 0
        }
      };
      if (looksLikeShopifyUnauthorizedError(message)) {
        payload.hint = shopifyAdminAuthEnvHint(target);
      }
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify(payload)
      };
    }

    const byrdMap = mergeQuantitiesBySku(
      byrdStock.map((b) => ({ sku: b.sku, quantity: b.quantity })),
    );
    const { quantities: shopifyMap, inventoryItemsBySku } =
      groupShopifyLevelsByNormalizedSku(shopifyStock);
    const allSkus = new Set([...byrdMap.keys(), ...shopifyMap.keys()]);
    const comparison = Array.from(allSkus)
      .sort()
      .map((sku) => {
        const byrdQty = byrdMap.get(sku) ?? null;
        const shopifyQty = shopifyMap.get(sku) ?? null;
        const items = inventoryItemsBySku.get(sku) ?? [];
        const match =
          byrdQty !== null &&
          shopifyQty !== null &&
          (items.length > 1
            ? items.every((it) => it.quantity === byrdQty)
            : byrdQty === shopifyQty);
        const shopifyProductKind = aggregateProductKindForSku(items);
        return {
          sku,
          byrd: byrdQty,
          /** Total disponible à la location UK (somme des items si plusieurs). */
          shopify: shopifyQty,
          match,
          shopifyProductKind,
          shopifyInventoryItemCount: items.length,
          shopifyInventoryItems: items.map((it) => ({
            inventoryItemGid: it.inventoryItemId,
            inventoryItemNumericId: shortShopifyInventoryItemGid(it.inventoryItemId),
            variantGid: it.variantGid ?? null,
            variantNumericId: it.variantNumericId ?? null,
            /** Disponible à la vente (aligné « Aligné » et sync). */
            available: it.quantity,
            /** @deprecated Utiliser `available` — même valeur. */
            quantity: it.quantity,
            onHand: it.onHand ?? null,
            committed: it.committed ?? null,
            productKind: it.productKind ?? "simple"
          }))
        };
      });

    const cfg = getConfig();

    const stats = {
      byrdProductCount: byrdStock.length,
      byrdUniqueSkuCount: byrdMap.size,
      shopifyInventoryItemCount: shopifyStock.length,
      shopifyUniqueSkuCount: shopifyMap.size,
      commonSkuCount: countCommonSkus(byrdMap.keys(), shopifyMap.keys())
    };

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        target,
        byrd: byrdStock,
        shopify: shopifyStock,
        locationName,
        comparison,
        stats,
        debug: {
          byrdWarehouseId: cfg.byrd.warehouseId || null,
          byrdStockCount: byrdStock.length,
          shopifyLocationGid: cfg.shopify.ukLocationId ? `gid://shopify/Location/${cfg.shopify.ukLocationId}` : null,
          shopifyAuthConfigured: shopifyAuthConfigured(cfg),
          shopifyStockCount: shopifyStock.length,
          byrdSample: byrdStock.slice(0, 10),
          shopifySample: shopifyStock.slice(0, 10)
        }
      })
    };
  });
};
