import { CONFIG } from "../config";
import { httpRequest } from "../utils/http";
import { logger } from "../utils/logger";
import { buildSkuToInventoryItemIdMap } from "../utils/mapping";

interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface InventoryItemNode {
  id: string;
  sku: string | null;
}

interface FulfillmentOrder {
  id: string;
  assignedLocation: {
    id: string;
  };
}

interface Fulfillment {
  id: string;
  trackingInfo: {
    number: string | null;
  }[];
}

export interface WmsStockItem {
  sku: string;
  quantity: number;
}

export interface WmsShipment {
  externalShipmentId: string;
  shopifyOrderId: string;
  trackingNumber: string;
  carrier: string;
  occurredAt: string;
}

const GRAPHQL_ENDPOINT = `https://${CONFIG.shopify.storeDomain}/admin/api/2024-10/graphql.json`;

async function shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await httpRequest<ShopifyGraphQLResponse<T>>(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": CONFIG.shopify.adminToken
    },
    body: {
      query,
      variables
    }
  });

  if (resp.errors && resp.errors.length > 0) {
    logger.error("shopify_graphql_error", { errors: resp.errors });
    throw new Error(resp.errors.map((e) => e.message).join("; "));
  }

  if (!resp.data) {
    throw new Error("Réponse Shopify sans data");
  }

  return resp.data;
}

export interface StockLevelItem {
  sku: string;
  quantity: number;
}

export class ShopifyService {
  private ukLocationGid: string;

  constructor() {
    this.ukLocationGid = `gid://shopify/Location/${CONFIG.shopify.ukLocationId}`;
  }

  /** Liste les niveaux de stock (disponible) pour la location UK. Pour le dashboard. */
  async fetchInventoryLevelsForUkLocation(): Promise<StockLevelItem[]> {
    const out: StockLevelItem[] = [];
    let cursor: string | null = null;
    const query = `
      query UkInventoryLevels($id: ID!, $after: String) {
        location(id: $id) {
          id
          inventoryLevels(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                item { sku }
                quantities(names: ["available"]) { quantity }
              }
            }
          }
        }
      }
    `;
    for (;;) {
      const data = await shopifyGraphQL<{
        location: {
          inventoryLevels: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{
              node: {
                item: { sku: string | null };
                quantities: Array<{ quantity: number }>;
              };
            }>;
          };
        } | null;
      }>(query, { id: this.ukLocationGid, after: cursor });
      if (!data?.location?.inventoryLevels) break;
      const { pageInfo, edges } = data.location.inventoryLevels;
      for (const e of edges) {
        const sku = e.node.item?.sku;
        const qty = e.node.quantities?.[0]?.quantity ?? 0;
        if (sku != null) out.push({ sku, quantity: qty });
      }
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }
    return out;
  }

  async fetchInventoryItemsBySkus(skus: string[]): Promise<Map<string, string>> {
    // GraphQL ne permet pas une recherche massive par SKU très simplement, on fait des batches
    const batchSize = 20;
    const mappings: { sku: string; inventoryItemId: string }[] = [];

    for (let i = 0; i < skus.length; i += batchSize) {
      const batch = skus.slice(i, i + batchSize);
      const query = `
        query InventoryItemsBySku($query: String!, $first: Int!) {
          inventoryItems(first: $first, query: $query) {
            edges {
              node {
                id
                sku
              }
            }
          }
        }
      `;
      const queryValue = batch.map((sku) => `sku:${JSON.stringify(sku)}`).join(" OR ");
      const data = await shopifyGraphQL<{
        inventoryItems: { edges: { node: InventoryItemNode }[] };
      }>(query, { query: queryValue, first: batch.length });

      for (const edge of data.inventoryItems.edges) {
        if (edge.node.sku) {
          mappings.push({ sku: edge.node.sku, inventoryItemId: edge.node.id });
        }
      }
    }

    return buildSkuToInventoryItemIdMap(mappings);
  }

  async adjustInventoryLevels(items: WmsStockItem[], skuToInventoryItemId: Map<string, string>): Promise<void> {
    if (items.length === 0) return;

    const mutation = `
      mutation InventoryAdjustQuantity($input: InventoryAdjustQuantityInput!) {
        inventoryAdjustQuantity(input: $input) {
          inventoryLevel {
            id
            available
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const batchSize = 20;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      for (const item of batch) {
        const inventoryItemId = skuToInventoryItemId.get(item.sku);
        if (!inventoryItemId) {
          logger.warn("inventory_item_not_found_for_sku", { sku: item.sku });
          continue;
        }

        try {
          await shopifyGraphQL<{
            inventoryAdjustQuantity: {
              userErrors: { message: string }[];
            };
          }>(mutation, {
            input: {
              inventoryItemId,
              availableDelta: item.quantity, // Ici on suppose que WMS fournit un delta ; adapter si c'est un stock absolu
              locationId: this.ukLocationGid
            }
          });
          logger.info("stock_adjusted", { sku: item.sku, quantity: item.quantity });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (err) {
          logger.error("stock_adjust_error", { sku: item.sku, error: String(err) });
        }
      }
    }
  }

  async listFulfillmentOrdersForOrder(orderId: string): Promise<FulfillmentOrder[]> {
    const gidOrder = `gid://shopify/Order/${orderId}`;
    const query = `
      query FulfillmentOrders($id: ID!) {
        order(id: $id) {
          id
          fulfillmentOrders(first: 50) {
            edges {
              node {
                id
                assignedLocation {
                  id
                }
              }
            }
          }
        }
      }
    `;
    const data = await shopifyGraphQL<{
      order: {
        fulfillmentOrders: { edges: { node: FulfillmentOrder }[] };
      } | null;
    }>(query, { id: gidOrder });

    if (!data.order) return [];
    return data.order.fulfillmentOrders.edges
      .map((e) => e.node)
      .filter((fo) => fo.assignedLocation.id === this.ukLocationGid);
  }

  async listExistingFulfillments(orderId: string): Promise<Fulfillment[]> {
    const gidOrder = `gid://shopify/Order/${orderId}`;
    const query = `
      query Fulfillments($id: ID!) {
        order(id: $id) {
          id
          fulfillments(first: 50) {
            edges {
              node {
                id
                trackingInfo {
                  number
                }
              }
            }
          }
        }
      }
    `;
    const data = await shopifyGraphQL<{
      order: {
        fulfillments: { edges: { node: Fulfillment }[] };
      } | null;
    }>(query, { id: gidOrder });

    if (!data.order) return [];
    return data.order.fulfillments.edges.map((e) => e.node);
  }

  async createFulfillmentForShipment(shipment: WmsShipment, fulfillmentOrderId: string): Promise<void> {
    const mutation = `
      mutation FulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const trackingInfo = {
      number: shipment.trackingNumber,
      company: shipment.carrier
    };

    const data = await shopifyGraphQL<{
      fulfillmentCreateV2: {
        fulfillment: { id: string } | null;
        userErrors: { message: string }[];
      };
    }>(mutation, {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId,
            fulfillmentOrderLineItems: "ALL"
          }
        ],
        trackingInfo
      }
    });

    const errors = data.fulfillmentCreateV2.userErrors;
    if (errors && errors.length > 0) {
      logger.error("fulfillment_create_error", {
        shipmentId: shipment.externalShipmentId,
        errors
      });
      return;
    }

    logger.info("fulfillment_created", {
      shipmentId: shipment.externalShipmentId,
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier
    });
  }
}

