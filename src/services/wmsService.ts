import { CONFIG } from "../config";
import { httpRequest } from "../utils/http";
import { logger } from "../utils/logger";
import type { WmsShipment, WmsStockItem } from "./shopifyService";
import {
  isByrdConfigured,
  listByrdProducts,
  listByrdShipments
} from "./byrdClient";

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

  private async fetchStockFromByrd(): Promise<WmsStockItem[]> {
    try {
      const products = await listByrdProducts();
      const warehouseId = CONFIG.byrd.warehouseId;
      const items: WmsStockItem[] = [];
      for (const p of products) {
        const stocks = p.stocksByWarehouse ?? {};
        const warehouseKeys = Object.keys(stocks);
        const targetKey = warehouseId && stocks[warehouseId] !== undefined
          ? warehouseId
          : warehouseKeys[0];
        if (!targetKey) continue;
        const available = stocks[targetKey]?.available ?? 0;
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
      const url = `${CONFIG.wms.baseUrl}/stock?warehouse=UK`;
      const data = await httpRequest<{ items: { sku: string; quantity: number }[] }>(url, {
        headers: { "X-API-Key": CONFIG.wms.apiKey }
      });
      return (data.items ?? []).map((i) => ({ sku: i.sku, quantity: i.quantity }));
    } catch (err) {
      logger.error("wms_stock_fetch_error", { error: String(err) });
      return [];
    }
  }

  /**
   * Récupère les expéditions mises à jour depuis une date.
   * Byrd: GET /v3/shipments avec date_field=updated_at et date_from.
   */
  async fetchShipmentsSince(updatedSinceIso: string): Promise<WmsShipment[]> {
    if (isByrdConfigured()) {
      return this.fetchShipmentsFromByrd(updatedSinceIso);
    }
    return this.fetchShipmentsFromGenericWms(updatedSinceIso);
  }

  private async fetchShipmentsFromByrd(updatedSinceIso: string): Promise<WmsShipment[]> {
    try {
      const list = await listByrdShipments({
        dateFrom: updatedSinceIso,
        dateField: "updated_at",
        warehouseId: CONFIG.byrd.warehouseId || undefined,
        status: ["sent", "delivered", "packaged"]
      });
      return list
        .filter((s) => s.shop?.order_id)
        .map((s) => {
          const unit = s.units?.[0];
          const tracking = unit?.carrier?.tracking_number ?? "";
          const carrier = unit?.carrier?.name ?? "unknown";
          const occurredAt = s.checkpoints?.sent_at ?? s.checkpoints?.packaged_at ?? s.updated_at;
          return {
            externalShipmentId: s.id,
            shopifyOrderId: String(s.shop!.order_id),
            trackingNumber: tracking,
            carrier,
            occurredAt: occurredAt ?? s.updated_at
          };
        });
    } catch (err) {
      logger.error("byrd_shipments_fetch_error", { error: String(err) });
      return [];
    }
  }

  private async fetchShipmentsFromGenericWms(updatedSinceIso: string): Promise<WmsShipment[]> {
    try {
      const url = `${CONFIG.wms.baseUrl}/shipments?warehouse=UK&updated_since=${encodeURIComponent(updatedSinceIso)}`;
      const data = await httpRequest<{
        shipments: Array<{
          id: string;
          shopify_order_id: string;
          tracking_number: string;
          carrier: string;
          occurred_at: string;
        }>;
      }>(url, {
        headers: { "X-API-Key": CONFIG.wms.apiKey }
      });
      return (data.shipments ?? []).map((s) => ({
        externalShipmentId: s.id,
        shopifyOrderId: s.shopify_order_id,
        trackingNumber: s.tracking_number,
        carrier: s.carrier,
        occurredAt: s.occurred_at
      }));
    } catch (err) {
      logger.error("wms_shipments_fetch_error", { error: String(err) });
      return [];
    }
  }
}
