import { ShopifyService, type WmsStockItem } from "../services/shopifyService";
import { WmsService } from "../services/wmsService";
import { logger } from "../utils/logger";
import { isByrdConfigured } from "../services/byrdClient";

export async function runStockSync(): Promise<void> {
  logger.info("stock_sync_started");

  const wms = new WmsService();
  const shopify = new ShopifyService();

  const wmsItems: WmsStockItem[] = await wms.fetchStockForUk();
  if (wmsItems.length === 0) {
    logger.info("stock_sync_completed", { processed: 0 });
    return;
  }

  // Byrd renvoie des quantités absolues : on calcule le delta par rapport à Shopify pour éviter d’écraser.
  let toApply: WmsStockItem[] = wmsItems;
  if (isByrdConfigured()) {
    const current = await shopify.fetchInventoryLevelsForUkLocation();
    const currentMap = new Map(current.map((c) => [c.sku, c.quantity]));
    toApply = wmsItems
      .map((i) => ({ sku: i.sku, quantity: i.quantity - (currentMap.get(i.sku) ?? 0) }))
      .filter((i) => i.quantity !== 0);
    if (toApply.length === 0) {
      logger.info("stock_sync_completed", { processed: 0, reason: "no_delta" });
      return;
    }
  }

  const skus = Array.from(new Set(toApply.map((i) => i.sku))).filter(Boolean);
  const skuToInventoryItemId = await shopify.fetchInventoryItemsBySkus(skus);

  await shopify.adjustInventoryLevels(toApply, skuToInventoryItemId);

  logger.info("stock_sync_completed", { processed: toApply.length });
}

