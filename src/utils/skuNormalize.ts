/**
 * Alignement Byrd ↔ Shopify : les deux systèmes peuvent renvoyer le même SKU avec
 * des espaces en trop ou des espaces internes différents, ce qui créait deux lignes
 * dans le dashboard au lieu d’une.
 */
export function normalizeSku(s: string | null | undefined): string {
  if (s == null || s === "") return "";
  return String(s).trim().replace(/\s+/g, " ");
}

/** Somme les quantités pour un même SKU normalisé (doublons API / pagination). */
export function mergeQuantitiesBySku(
  rows: { sku: string; quantity: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of rows) {
    const k = normalizeSku(it.sku);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + it.quantity);
  }
  return m;
}

/** Niveaux Shopify à la location (SKU + qty + inventory item). */
export interface ShopifyLevelRow {
  sku: string;
  /** Quantité « available » (vente) — alignée sur la sync et la colonne « Aligné ». */
  quantity: number;
  inventoryItemId: string;
  onHand?: number;
  committed?: number;
  variantGid?: string | null;
  variantNumericId?: string | null;
  productKind?: "simple" | "bundle" | "component";
}

/** Ligne agrégée par SKU : quantité à la location (UK) pour chaque InventoryItem distinct. */
export interface ShopifyInventoryItemAtLocation {
  inventoryItemId: string;
  /** Quantité « available » (vente) — peut être négative si le stock engagé dépasse le physique. */
  quantity: number;
  onHand?: number;
  committed?: number;
  variantGid?: string | null;
  variantNumericId?: string | null;
  productKind?: "simple" | "bundle" | "component";
}

/**
 * Quantités totales par SKU normalisé + détail par InventoryItem (même ordre que l’itération API).
 * Si le même item apparaît plusieurs fois dans les niveaux, les quantités sont additionnées sur la même ligne.
 */
export function groupShopifyLevelsByNormalizedSku(
  levels: ShopifyLevelRow[],
): {
  quantities: Map<string, number>;
  inventoryItemsBySku: Map<string, ShopifyInventoryItemAtLocation[]>;
} {
  const quantities = new Map<string, number>();
  const inventoryItemsBySku = new Map<string, ShopifyInventoryItemAtLocation[]>();
  for (const L of levels) {
    const k = normalizeSku(L.sku);
    if (!k || !L.inventoryItemId) continue;
    quantities.set(k, (quantities.get(k) ?? 0) + L.quantity);
    let arr = inventoryItemsBySku.get(k);
    if (!arr) {
      arr = [];
      inventoryItemsBySku.set(k, arr);
    }
    const idx = arr.findIndex((x) => x.inventoryItemId === L.inventoryItemId);
    if (idx >= 0) {
      arr[idx].quantity += L.quantity;
      if (L.onHand != null) arr[idx].onHand = (arr[idx].onHand ?? 0) + L.onHand;
      if (L.committed != null)
        arr[idx].committed = (arr[idx].committed ?? 0) + L.committed;
    } else {
      arr.push({
        inventoryItemId: L.inventoryItemId,
        quantity: L.quantity,
        onHand: L.onHand,
        committed: L.committed,
        variantGid: L.variantGid ?? null,
        variantNumericId: L.variantNumericId ?? null,
        productKind: L.productKind
      });
    }
  }
  return { quantities, inventoryItemsBySku };
}

/** Extrait l’ID numérique depuis `gid://shopify/InventoryItem/123`. */
export function shortShopifyInventoryItemGid(gid: string): string {
  const m = /InventoryItem\/(\d+)/.exec(gid);
  return m ? m[1] : gid;
}

/** Extrait l’ID numérique depuis `gid://shopify/ProductVariant/123` (souvent visible dans l’admin). */
export function shortShopifyVariantGid(gid: string | null | undefined): string {
  if (!gid) return "";
  const m = /ProductVariant\/(\d+)/.exec(gid);
  return m ? m[1] : gid;
}

/** Agrège le type produit (ligne SKU) quand plusieurs variantes / items partagent le même SKU. */
export function aggregateProductKindForSku(
  items: Array<{ productKind?: "simple" | "bundle" | "component" }>,
): "simple" | "bundle" | "component" | "mixed" | null {
  if (items.length === 0) return null;
  const kinds = items.map((i) => i.productKind ?? "simple");
  const set = new Set(kinds);
  if (set.size === 1) return kinds[0];
  return "mixed";
}
