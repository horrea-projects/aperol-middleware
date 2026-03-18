export interface SkuInventoryMapping {
  sku: string;
  inventoryItemId: string;
}

export function buildSkuToInventoryItemIdMap(items: SkuInventoryMapping[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    map.set(item.sku, item.inventoryItemId);
  }
  return map;
}

