import {
  ShopifyService,
  type InventoryAdjustInput,
  type StockAdjustLine,
} from "../services/shopifyService";
import { WmsService } from "../services/wmsService";
import { logger } from "../utils/logger";
import { isByrdConfigured } from "../services/byrdClient";
import {
  groupShopifyLevelsByNormalizedSku,
  mergeQuantitiesBySku,
} from "../utils/skuNormalize";

export interface StockSyncResult {
  processedSkus: number;
  appliedItems: number;
  userErrors: number;
  skippedMissingItemId: number;
  mode: "byrd" | "generic";
  /** Détail par SKU (produit / variante) pour les ajustements de stock. */
  lines: StockAdjustLine[];
}

export async function runStockSync(): Promise<StockSyncResult> {
  logger.info("stock_sync_started");

  const wms = new WmsService();
  const shopify = new ShopifyService();

  const wmsItems = await wms.fetchStockForUk();
  if (wmsItems.length === 0) {
    logger.info("stock_sync_completed", { processed: 0 });
    return {
      processedSkus: 0,
      appliedItems: 0,
      userErrors: 0,
      skippedMissingItemId: 0,
      mode: isByrdConfigured() ? "byrd" : "generic",
      lines: [],
    };
  }

  const wmsMerged = mergeQuantitiesBySku(
    wmsItems.map((i) => ({ sku: i.sku, quantity: i.quantity })),
  );

  const levels = await shopify.fetchInventoryLevelsForUkLocation();
  const { quantities: shopifyQtyBySku, inventoryItemsBySku } =
    groupShopifyLevelsByNormalizedSku(levels);

  const toApply: InventoryAdjustInput[] = [];
  const mode: "byrd" | "generic" = isByrdConfigured() ? "byrd" : "generic";

  if (isByrdConfigured()) {
    // Delta = total WMS − total Shopify pour le SKU. S’il existe plusieurs InventoryItem
    // avec le même SKU à la location UK, un seul reçoit le delta (le premier) : le total
    // disponible à l’entrepôt reste correct.
    const needFallback: string[] = [];
    for (const [sku, wmsQty] of wmsMerged) {
      const shopQty = shopifyQtyBySku.get(sku) ?? 0;
      const delta = wmsQty - shopQty;
      if (delta === 0) continue;
      const id = inventoryItemsBySku.get(sku)?.[0]?.inventoryItemId;
      if (id) toApply.push({ sku, quantity: delta, inventoryItemId: id });
      else needFallback.push(sku);
    }
    if (needFallback.length > 0) {
      const fb = await shopify.fetchInventoryItemsBySkus(needFallback);
      for (const sku of needFallback) {
        const wmsQty = wmsMerged.get(sku)!;
        const shopQty = shopifyQtyBySku.get(sku) ?? 0;
        const delta = wmsQty - shopQty;
        if (delta === 0) continue;
        const iid = fb.get(sku);
        if (iid) toApply.push({ sku, quantity: delta, inventoryItemId: iid });
      }
    }
    if (toApply.length === 0) {
      logger.info("stock_sync_completed", { processed: 0, reason: "no_delta" });
      return {
        processedSkus: wmsMerged.size,
        appliedItems: 0,
        userErrors: 0,
        skippedMissingItemId: 0,
        mode,
        lines: [],
      };
    }
  } else {
    const needFallback: string[] = [];
    for (const [sku, quantity] of wmsMerged) {
      const id = inventoryItemsBySku.get(sku)?.[0]?.inventoryItemId;
      if (id) toApply.push({ sku, quantity, inventoryItemId: id });
      else needFallback.push(sku);
    }
    if (needFallback.length > 0) {
      const fb = await shopify.fetchInventoryItemsBySkus(needFallback);
      for (const sku of needFallback) {
        const qty = wmsMerged.get(sku)!;
        const iid = fb.get(sku);
        if (iid) toApply.push({ sku, quantity: qty, inventoryItemId: iid });
      }
    }
  }

  const summary = await shopify.adjustInventoryLevels(toApply);

  logger.info("stock_sync_completed", { processed: toApply.length, summary });
  return {
    processedSkus: wmsMerged.size,
    appliedItems: summary.adjusted,
    userErrors: summary.userErrors,
    skippedMissingItemId: summary.skippedMissingItemId,
    mode,
    lines: summary.lines,
  };
}
