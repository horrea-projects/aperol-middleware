import { normalizeSku } from "./skuNormalize";

export interface SkuInventoryMapping {
  sku: string;
  inventoryItemId: string;
}

export function buildSkuToInventoryItemIdMap(items: SkuInventoryMapping[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const k = normalizeSku(item.sku);
    if (k) map.set(k, item.inventoryItemId);
  }
  return map;
}

