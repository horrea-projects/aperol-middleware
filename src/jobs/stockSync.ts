import {
  ShopifyService,
  type InventoryAdjustInput,
  type StockAdjustLine,
} from "../services/shopifyService";
import { getConfig } from "../config";
import { WmsService } from "../services/wmsService";
import { logger } from "../utils/logger";
import { isByrdConfigured } from "../services/byrdClient";
import {
  groupShopifyLevelsByNormalizedSku,
  mergeQuantitiesBySku,
  normalizeSku,
} from "../utils/skuNormalize";
import { loadSyncExclusionsSetForTarget } from "../utils/syncExclusionsStore";

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
  const config = getConfig();
  const envExcludedSkus = config.sync.excludedSkus;
  const uiExcludedSkus = await loadSyncExclusionsSetForTarget(config.target);
  const excludedSkus = new Set([...envExcludedSkus, ...uiExcludedSkus]);

  const wmsItems = await wms.fetchStockForUk();
  const wmsItemsFiltered = wmsItems.filter(
    (i) => !excludedSkus.has(normalizeSku(i.sku)),
  );
  if (wmsItemsFiltered.length === 0) {
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
    wmsItemsFiltered.map((i) => ({ sku: i.sku, quantity: i.quantity })),
  );

  const levels = await shopify.fetchInventoryLevelsForUkLocation();
  const { inventoryItemsBySku } = groupShopifyLevelsByNormalizedSku(levels);

  const toApply: InventoryAdjustInput[] = [];
  const mode: "byrd" | "generic" = isByrdConfigured() ? "byrd" : "generic";

  const needFallback: string[] = [];
  for (const [sku, wmsQty] of wmsMerged) {
    const shopItems = inventoryItemsBySku.get(sku) ?? [];
    if (shopItems.length === 0) {
      needFallback.push(sku);
      continue;
    }
    // Chaque inventory item portant ce SKU doit converger vers la même quantité WMS.
    for (const item of shopItems) {
      const delta = wmsQty - item.quantity;
      if (delta === 0) continue;
      toApply.push({ sku, quantity: delta, inventoryItemId: item.inventoryItemId });
    }
  }
  if (needFallback.length > 0) {
    // Fallback API par SKU : Shopify retourne un item, on applique le delta sur cet item.
    // Le cas multi-items est déjà correctement géré quand le SKU est présent dans la location UK.
    const fb = await shopify.fetchInventoryItemsBySkus(needFallback);
    for (const sku of needFallback) {
      const wmsQty = wmsMerged.get(sku)!;
      const iid = fb.get(sku);
      if (!iid) continue;
      toApply.push({ sku, quantity: wmsQty, inventoryItemId: iid });
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
