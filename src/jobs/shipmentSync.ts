import { ShopifyService } from "../services/shopifyService";
import { WmsService } from "../services/wmsService";
import { logger } from "../utils/logger";
import { getLastShipmentCheckpoint, setLastShipmentCheckpoint } from "../utils/locks";
import { isDuplicateTrackingNumber } from "../utils/idempotency";
import { CONFIG } from "../config";

export async function runShipmentSync(): Promise<void> {
  logger.info("shipment_sync_started");

  const wms = new WmsService();
  const shopify = new ShopifyService();

  // Checkpoint ou fallback sur une fenêtre glissante
  const now = new Date();
  const fallbackSince = new Date(now.getTime() - CONFIG.sync.shipmentWindowMinutes * 60 * 1000);
  const lastCheckpoint = (await getLastShipmentCheckpoint()) ?? fallbackSince.toISOString();

  const shipments = await wms.fetchShipmentsSince(lastCheckpoint);
  if (shipments.length === 0) {
    logger.info("shipment_sync_completed", { processed: 0 });
    await setLastShipmentCheckpoint(now.toISOString());
    return;
  }

  for (const shipment of shipments) {
    try {
      // On ne traite que les commandes avec des fulfillment_orders assignés au UK
      const fulfillmentOrders = await shopify.listFulfillmentOrdersForOrder(shipment.shopifyOrderId);
      if (fulfillmentOrders.length === 0) {
        logger.info("shipment_skipped_no_uk_fulfillment_order", {
          orderId: shipment.shopifyOrderId,
          shipmentId: shipment.externalShipmentId
        });
        continue;
      }

      // Idempotence : vérifier les fulfillments existants par tracking_number
      const existingFulfillments = await shopify.listExistingFulfillments(shipment.shopifyOrderId);
      const existingTracking = existingFulfillments
        .flatMap((f) => f.trackingInfo)
        .map((t) => t.number || "")
        .filter(Boolean);

      if (isDuplicateTrackingNumber(existingTracking, shipment.trackingNumber)) {
        logger.info("fulfillment_skipped", {
          reason: "duplicate_tracking",
          shipmentId: shipment.externalShipmentId,
          trackingNumber: shipment.trackingNumber
        });
        continue;
      }

      // On prend le premier fulfillment_order assigné au UK
      const fulfillmentOrderId = fulfillmentOrders[0].id;
      await shopify.createFulfillmentForShipment(shipment, fulfillmentOrderId);
    } catch (err) {
      logger.error("shipment_processing_error", {
        shipmentId: shipment.externalShipmentId,
        error: String(err)
      });
    }
  }

  await setLastShipmentCheckpoint(now.toISOString());
  logger.info("shipment_sync_completed", { processed: shipments.length });
}

