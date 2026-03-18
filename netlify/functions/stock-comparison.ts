import type { Handler } from "@netlify/functions";
import { CONFIG } from "../../src/config";
import { ShopifyService } from "../../src/services/shopifyService";
import { listByrdProducts, isByrdConfigured } from "../../src/services/byrdClient";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const byrdStock: { sku: string; quantity: number; name?: string }[] = [];
  let shopifyStock: { sku: string; quantity: number }[] = [];

  try {
    if (isByrdConfigured()) {
      const products = await listByrdProducts();
      const wid = CONFIG.byrd.warehouseId;
      for (const p of products) {
        const stocks = p.stocksByWarehouse ?? {};
        const key = wid && stocks[wid] !== undefined ? wid : Object.keys(stocks)[0];
        if (!key) continue;
        const qty = stocks[key]?.available ?? 0;
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
        byrd: [],
        shopify: [],
        comparison: []
      })
    };
  }

  try {
    if (CONFIG.shopify.storeDomain && CONFIG.shopify.adminToken && CONFIG.shopify.ukLocationId) {
      const shopify = new ShopifyService();
      shopifyStock = await shopify.fetchInventoryLevelsForUkLocation();
    }
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "shopify_fetch_failed",
        message: String(err),
        byrd: byrdStock,
        shopify: [],
        comparison: byrdStock.map((b) => ({
          sku: b.sku,
          byrd: b.quantity,
          shopify: null,
          match: false
        }))
      })
    };
  }

  const byrdMap = new Map(byrdStock.map((b) => [b.sku, b.quantity]));
  const shopifyMap = new Map(shopifyStock.map((s) => [s.sku, s.quantity]));
  const allSkus = new Set([...byrdMap.keys(), ...shopifyMap.keys()]);
  const comparison = Array.from(allSkus).map((sku) => {
    const byrdQty = byrdMap.get(sku) ?? null;
    const shopifyQty = shopifyMap.get(sku) ?? null;
    const match = byrdQty !== null && shopifyQty !== null && byrdQty === shopifyQty;
    return { sku, byrd: byrdQty, shopify: shopifyQty, match };
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      byrd: byrdStock,
      shopify: shopifyStock,
      comparison
    })
  };
};
