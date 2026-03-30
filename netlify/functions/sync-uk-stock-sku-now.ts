import type { Handler } from "@netlify/functions";
import {
  assertConfig,
  buildConfig,
  parseSyncTarget,
  runWithConfig,
  looksLikeShopifyUnauthorizedError,
  shopifyAdminAuthEnvHint
} from "../../src/config";
import { ShopifyService } from "../../src/services/shopifyService";
import { WmsService } from "../../src/services/wmsService";
import { guardDashboardAuth } from "../../src/utils/dashboardAuth";
import { logger } from "../../src/utils/logger";
import { bindNetlifyBlobsForLambda } from "../../src/utils/netlifyBlobsLambda";
import { sendSlackRunReport } from "../../src/utils/slack";
import {
  groupShopifyLevelsByNormalizedSku,
  normalizeSku,
  shortShopifyInventoryItemGid
} from "../../src/utils/skuNormalize";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cookie",
  "Content-Type": "application/json"
};

export const handler: Handler = async (event) => {
  bindNetlifyBlobsForLambda(event);
  const authFail = guardDashboardAuth(event, CORS_HEADERS);
  if (authFail) return authFail;

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const target = parseSyncTarget(event.queryStringParameters?.target);
  const config = buildConfig(target);
  try {
    assertConfig(config);
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "config_incomplete", target, message: String(err) })
    };
  }

  const sku = normalizeSku(String(event.queryStringParameters?.sku ?? ""));
  const dryRun = String(event.queryStringParameters?.dryRun ?? "true").toLowerCase() === "true";

  if (!sku) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "missing_sku" }) };
  }

  return runWithConfig(config, async () => {
    const startedAt = Date.now();
    const runId = `stock-test-sku:${target}:${Date.now()}`;
    try {
      const wms = new WmsService();
      const shopify = new ShopifyService();
      const locationName = await shopify.fetchUkLocationName();

      logger.info("stock_test_sku_started", { target, runId, sku, dryRun });

      const desired = (await wms.fetchStockForUkSku(sku)).quantity;
      const levels = await shopify.fetchInventoryLevelsForUkLocation();
      const { quantities, inventoryItemsBySku } =
        groupShopifyLevelsByNormalizedSku(levels);
      const norm = normalizeSku(sku);
      const current = quantities.get(norm) ?? 0;
      const delta = desired - current;
      const shopifyInventoryItems = (inventoryItemsBySku.get(norm) ?? []).map(
        (it) => ({
          inventoryItemGid: it.inventoryItemId,
          inventoryItemNumericId: shortShopifyInventoryItemGid(it.inventoryItemId),
          variantGid: it.variantGid ?? null,
          variantNumericId: it.variantNumericId ?? null,
          available: it.quantity,
          quantity: it.quantity,
          onHand: it.onHand ?? null,
          committed: it.committed ?? null,
          productKind: it.productKind ?? "simple"
        })
      );

      if (delta === 0) {
        logger.info("stock_test_sku_no_change", { target, runId, sku, desired, current });
        await sendSlackRunReport(`[OK] test stock SKU ${sku} (${target}) — aucun changement`, {
          target,
          runId,
          sku,
          desired,
          current,
          delta,
          dryRun
        });
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            target,
            runId,
            sku: norm,
            desired,
            current,
            delta,
            dryRun,
            locationName,
            skipped: true,
            shopifyInventoryItems
          })
        };
      }

      if (dryRun) {
        logger.info("stock_test_sku_dry_run", { target, runId, sku, desired, current, delta });
        await sendSlackRunReport(`[DRY-RUN] test stock SKU ${sku} (${target}) — delta=${delta}`, {
          target,
          runId,
          sku,
          desired,
          current,
          delta
        });
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            target,
            runId,
            sku: norm,
            desired,
            current,
            delta,
            dryRun,
            locationName,
            skipped: false,
            shopifyInventoryItems
          })
        };
      }

      let inventoryItemId = inventoryItemsBySku.get(norm)?.[0]?.inventoryItemId;
      if (!inventoryItemId) {
        const fb = await shopify.fetchInventoryItemsBySkus([norm]);
        inventoryItemId = fb.get(norm) ?? "";
      }
      if (!inventoryItemId) {
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            error: "no_inventory_item",
            message: "Aucun article d’inventaire Shopify pour ce SKU à la location UK.",
            target,
            runId,
            sku: norm,
            desired,
            current,
            delta,
            shopifyInventoryItems
          })
        };
      }
      const summary = await shopify.adjustInventoryLevels([
        { sku: norm, quantity: delta, inventoryItemId }
      ]);
      const currentAfter = await shopify.fetchInventoryQuantityForUkLocationSku(norm);
      const deltaAfter = desired - currentAfter;

      logger.info("stock_test_sku_completed", { target, runId, sku, desired, current, delta, summary });

      await sendSlackRunReport(`[ALERTE?] test stock SKU ${sku} (${target}) terminé`, {
        target,
        runId,
        sku,
        desired,
        current,
        delta,
        currentAfter,
        deltaAfter,
        summary,
        durationSec: Math.round((Date.now() - startedAt) / 1000)
      });

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          target,
          runId,
          sku: norm,
          desired,
          current,
          delta,
          currentAfter,
          deltaAfter,
          dryRun: false,
          locationName,
          shopifyInventoryItems,
          summary
        })
      };
    } catch (err) {
      const message = String(err);
      const payload: any = {
        error: "stock_test_sku_failed",
        target,
        runId,
        message
      };
      if (looksLikeShopifyUnauthorizedError(message)) {
        payload.hint = shopifyAdminAuthEnvHint(target);
      }

      logger.error("stock_test_sku_error", { target, runId, sku, error: message });
      await sendSlackRunReport(`[ALERTE] test stock SKU ${sku} (${target}) — erreur`, { target, runId, sku, error: message });

      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify(payload) };
    }
  });
};

