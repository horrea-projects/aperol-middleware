import { getConfig } from "../config";
import { httpRequest } from "../utils/http";
import { logger } from "../utils/logger";
import type { WmsStockItem } from "./shopifyService";
import { fetchByrdStockForSku, isByrdConfigured, listByrdProducts } from "./byrdClient";

export class WmsService {
  /**
   * Récupère le stock pour l’entrepôt UK.
   * Si Byrd est configuré: utilise l’API Byrd (stocksByWarehouse).
   * Sinon: appelle l’endpoint WMS générique (WMS_BASE_URL + WMS_API_KEY).
   */
  async fetchStockForUk(): Promise<WmsStockItem[]> {
    if (isByrdConfigured()) {
      return this.fetchStockFromByrd();
    }
    return this.fetchStockFromGenericWms();
  }

  /** Variante utilitaire pour tester un SKU précis (UK uniquement). */
  async fetchStockForUkSku(sku: string): Promise<WmsStockItem> {
    if (isByrdConfigured()) {
      const b = await fetchByrdStockForSku(sku);
      return { sku, quantity: b.quantity };
    }

    const all = await this.fetchStockForUk();
    const found = all.find((i) => i.sku === sku);
    return { sku, quantity: found?.quantity ?? 0 };
  }

  private async fetchStockFromByrd(): Promise<WmsStockItem[]> {
    try {
      const products = await listByrdProducts();
      const warehouseId = getConfig().byrd.warehouseId;
      const items: WmsStockItem[] = [];
      for (const p of products) {
        const stocks = p.stocksByWarehouse ?? {};
        let available = 0;
        if (warehouseId) {
          available = stocks[warehouseId]?.available ?? 0;
        } else {
          const anyKey = Object.keys(stocks)[0];
          available = anyKey ? stocks[anyKey]?.available ?? 0 : 0;
        }
        if (p.sku) items.push({ sku: p.sku, quantity: available });
      }
      return items;
    } catch (err) {
      logger.error("byrd_stock_fetch_error", { error: String(err) });
      return [];
    }
  }

  private async fetchStockFromGenericWms(): Promise<WmsStockItem[]> {
    try {
      const url = `${getConfig().wms.baseUrl}/stock?warehouse=UK`;
      const data = await httpRequest<{ items: { sku: string; quantity: number }[] }>(url, {
        headers: { "X-API-Key": getConfig().wms.apiKey }
      });
      return (data.items ?? []).map((i) => ({ sku: i.sku, quantity: i.quantity }));
    } catch (err) {
      logger.error("wms_stock_fetch_error", { error: String(err) });
      return [];
    }
  }
}
