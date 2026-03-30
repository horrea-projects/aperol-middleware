import { getConfig, type AppConfig } from "../config";
import { HttpStatusError, httpRequest } from "../utils/http";
import { logger } from "../utils/logger";
import {
  getShopifyAdminAccessToken,
  invalidateShopifyAccessTokenCache,
} from "../utils/shopifyAccessToken";

/** Un seul avertissement par exécution (évite le spam dans les logs). */
let shopifyAdminTokenFormatWarned = false;

function warnOnceIfAdminTokenFormatUnusual(token: string): void {
  if (shopifyAdminTokenFormatWarned || !token) return;
  if (token.startsWith("shpat_") || token.startsWith("shpca_")) return;
  shopifyAdminTokenFormatWarned = true;
  logger.warn("shopify_admin_token_unexpected_prefix", {
    message:
      "Préfixes courants : shpat_ / shpca_. Vérifier qu’il s’agit bien d’un Admin API access token (pas du secret client shpss_).",
  });
}
import { buildSkuToInventoryItemIdMap } from "../utils/mapping";
import { normalizeSku } from "../utils/skuNormalize";

interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface InventoryItemNode {
  id: string;
  sku: string | null;
}

export interface WmsStockItem {
  sku: string;
  quantity: number;
}

/** Ajustement ciblé sur un inventory item Shopify (plusieurs peuvent partager le même SKU). */
export interface InventoryAdjustInput extends WmsStockItem {
  inventoryItemId: string;
}

/** Une ligne par tentative d’ajustement de stock (SKU / delta), pour l’historique des runs. */
export type StockAdjustLineStatus =
  | "adjusted"
  | "skipped_no_inventory_item"
  | "user_error"
  | "exception";

export interface StockAdjustLine {
  sku: string;
  delta: number;
  status: StockAdjustLineStatus;
  /** Inventory item ajusté (si applicable). */
  inventoryItemId?: string;
  messages?: string[];
  error?: string;
}

function shopifyGraphqlUrl(app: AppConfig): string {
  return `https://${app.shopify.storeDomain}/admin/api/2024-10/graphql.json`;
}

function shopifyAuthDebugEnabled(): boolean {
  return (
    process.env.SHOPIFY_DEBUG === "1" || process.env.DASHBOARD_DEBUG === "1"
  );
}

/** Logs sans secret : préfixes uniquement. Activer `SHOPIFY_DEBUG=1` ou `DASHBOARD_DEBUG=1`. */
function logShopifyAuthDebug(
  app: AppConfig,
  accessToken: string,
  phase: string,
): void {
  if (!shopifyAuthDebugEnabled()) return;
  const s = app.shopify;
  logger.info("shopify_auth_debug", {
    phase,
    target: app.target,
    storeDomain: s.storeDomain,
    authMode: s.adminToken ? "static_admin_token" : "client_credentials",
    clientIdPrefix: s.clientId ? `${s.clientId.slice(0, 10)}…` : null,
    tokenPrefix: accessToken ? `${accessToken.slice(0, 14)}…` : null,
    graphqlPath: "/admin/api/2024-10/graphql.json",
  });
}

async function shopifyGraphQLRequest<T>(
  app: AppConfig,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown> | undefined,
): Promise<T> {
  const resp = await httpRequest<ShopifyGraphQLResponse<T>>(
    shopifyGraphqlUrl(app),
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken.trim(),
      },
      body: {
        query,
        variables,
      },
    },
  );

  if (resp.errors && resp.errors.length > 0) {
    logger.error("shopify_graphql_error", { errors: resp.errors });
    throw new Error(resp.errors.map((e) => e.message).join("; "));
  }

  if (!resp.data) {
    throw new Error("Réponse Shopify sans data");
  }

  return resp.data;
}

async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const app = getConfig();
  let accessToken = await getShopifyAdminAccessToken(app);
  warnOnceIfAdminTokenFormatUnusual(accessToken);
  logShopifyAuthDebug(app, accessToken, "graphql_attempt");

  let oauth401Retry = false;
  for (;;) {
    try {
      return await shopifyGraphQLRequest(app, accessToken, query, variables);
    } catch (e) {
      if (
        e instanceof HttpStatusError &&
        e.statusCode === 401 &&
        !app.shopify.adminToken &&
        !oauth401Retry
      ) {
        invalidateShopifyAccessTokenCache(app);
        accessToken = await getShopifyAdminAccessToken(app);
        logShopifyAuthDebug(app, accessToken, "graphql_retry_after_401");
        oauth401Retry = true;
        continue;
      }
      throw e;
    }
  }
}

export interface StockLevelItem {
  sku: string;
  /** Quantité « available » (vente) — utilisée pour la sync et le comparateur « Aligné ». */
  quantity: number;
  /** `gid://shopify/InventoryItem/...` — plusieurs entrées possibles pour un même SKU. */
  inventoryItemId: string;
  /** Stock physique à la location (souvent ce que l’admin affiche comme « En stock »). */
  onHand?: number;
  committed?: number;
  variantGid?: string | null;
  /** ID numérique de variante (souvent celui visible dans l’URL / l’admin produit). */
  variantNumericId?: string | null;
  /** Produit simple, bundle (offre groupée) ou composant d’un bundle parent. */
  productKind?: "simple" | "bundle" | "component";
}

function readInventoryQuantityRows(
  rows: Array<{ name?: string | null; quantity: number }> | undefined,
): { available: number; onHand: number; committed: number } {
  let available = 0;
  let onHand = 0;
  let committed = 0;
  for (const r of rows ?? []) {
    const n = String(r.name ?? "")
      .toLowerCase()
      .replace(/_/g, "");
    if (n === "available") available = r.quantity;
    else if (n === "onhand") onHand = r.quantity;
    else if (n === "committed") committed = r.quantity;
  }
  return { available, onHand, committed };
}

function inferProductKindFromProduct(p: {
  bundleComponents?: {
    edges?: { node?: { componentProduct?: { id?: string } | null } | null }[];
  };
} | null): "simple" | "bundle" | "component" {
  if (!p) return "simple";
  const hasBundleParts = (p.bundleComponents?.edges?.length ?? 0) > 0;
  if (hasBundleParts) return "bundle";
  // « Composant » (SKU utilisé dans un bundle parent) : `productParents` n’existe pas sur
  // Product en API 2024-10 — détection désactivée tant qu’on ne remonte pas la version API.
  return "simple";
}

export class ShopifyService {
  private ukLocationGid: string;

  constructor() {
    this.ukLocationGid = `gid://shopify/Location/${getConfig().shopify.ukLocationId}`;
  }

  /** Récupère le nom de la location Shopify UK (pour l'affichage dashboard). */
  async fetchUkLocationName(): Promise<string> {
    const query = `
      query UkLocationName($id: ID!) {
        location(id: $id) { name }
      }
    `;

    const data = await shopifyGraphQL<{
      location: { name: string | null } | null;
    }>(query, { id: this.ukLocationGid });

    return data?.location?.name ?? "Shopify UK";
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
                item {
                  id
                  sku
                  variant {
                    id
                    legacyResourceId
                    product {
                      bundleComponents(first: 1) {
                        edges {
                          node {
                            componentProduct {
                              id
                            }
                          }
                        }
                      }
                    }
                  }
                }
                quantities(names: ["available", "on_hand", "committed"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    `;
    for (;;) {
      const data: {
        location: {
          inventoryLevels: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{
              node: {
                item: {
                  id: string;
                  sku: string | null;
                  variant: {
                    id: string;
                    legacyResourceId: string | null;
                    product: {
                      bundleComponents: {
                        edges: {
                          node: { componentProduct: { id: string } | null } | null;
                        }[];
                      };
                    } | null;
                  } | null;
                };
                quantities: Array<{ name?: string | null; quantity: number }>;
              };
            }>;
          };
        } | null;
      } = await shopifyGraphQL(query, {
        id: this.ukLocationGid,
        after: cursor,
      });
      if (!data?.location?.inventoryLevels) break;
      const { pageInfo, edges } = data.location.inventoryLevels;
      for (const e of edges) {
        const sku = e.node.item?.sku;
        const iid = e.node.item?.id;
        const v = e.node.item?.variant;
        const q = readInventoryQuantityRows(e.node.quantities);
        const variantNumericId =
          v?.legacyResourceId != null && v.legacyResourceId !== ""
            ? String(v.legacyResourceId)
            : null;
        const productKind = inferProductKindFromProduct(v?.product ?? null);
        if (sku != null && iid != null)
          out.push({
            sku,
            quantity: q.available,
            inventoryItemId: iid,
            onHand: q.onHand,
            committed: q.committed,
            variantGid: v?.id ?? null,
            variantNumericId,
            productKind
          });
      }
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }
    return out;
  }

  /** Récupère la quantité available pour un SKU précis à la location UK (utile pour tests single-SKU). */
  async fetchInventoryQuantityForUkLocationSku(sku: string): Promise<number> {
    let cursor: string | null = null;
    const query = `
      query UkInventoryLevels($id: ID!, $after: String) {
        location(id: $id) {
          inventoryLevels(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                item { id sku }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    `;

    const want = normalizeSku(sku);
    let total = 0;
    for (;;) {
      const data: {
        location: {
          inventoryLevels: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{
              node: {
                item: { id: string; sku: string | null };
                quantities: Array<{ name?: string | null; quantity: number }>;
              };
            }>;
          };
        } | null;
      } = await shopifyGraphQL(query, {
        id: this.ukLocationGid,
        after: cursor,
      });

      if (!data?.location?.inventoryLevels) break;
      const { pageInfo, edges } = data.location.inventoryLevels;

      for (const e of edges) {
        const rowSku = e.node.item?.sku;
        if (
          rowSku != null &&
          normalizeSku(rowSku) === want
        ) {
          total += readInventoryQuantityRows(e.node.quantities).available;
        }
      }

      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }

    return total;
  }

  async fetchInventoryItemsBySkus(
    skus: string[],
  ): Promise<Map<string, string>> {
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
      const queryValue = batch
        .map((sku) => `sku:${JSON.stringify(sku)}`)
        .join(" OR ");
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

  async adjustInventoryLevels(items: InventoryAdjustInput[]): Promise<{
    attempted: number;
    adjusted: number;
    skippedMissingItemId: number;
    userErrors: number;
    lines: StockAdjustLine[];
  }> {
    if (items.length === 0) {
      return {
        attempted: 0,
        adjusted: 0,
        skippedMissingItemId: 0,
        userErrors: 0,
        lines: [],
      };
    }

    const mutation = `
      mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    const batchSize = 20;
    const summary = {
      attempted: items.length,
      adjusted: 0,
      skippedMissingItemId: 0,
      userErrors: 0,
    };
    const lines: StockAdjustLine[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      for (const item of batch) {
        const inventoryItemId = item.inventoryItemId;
        if (!inventoryItemId) {
          logger.warn("inventory_item_not_found_for_sku", { sku: item.sku });
          summary.skippedMissingItemId++;
          lines.push({
            sku: item.sku,
            delta: item.quantity,
            status: "skipped_no_inventory_item",
          });
          continue;
        }

        try {
          const resp = await shopifyGraphQL<{
            inventoryAdjustQuantities: {
              userErrors: { field: string[] | null; message: string }[];
            };
          }>(mutation, {
            input: {
              reason: "correction",
              name: "available",
              referenceDocumentUri: "logistics://getbyrd/sync-uk",
              changes: [
                {
                  delta: item.quantity,
                  inventoryItemId,
                  locationId: this.ukLocationGid,
                },
              ],
            },
          });
          const errors = resp.inventoryAdjustQuantities.userErrors ?? [];
          if (errors.length > 0) {
            summary.userErrors += errors.length;
            logger.error("stock_adjust_user_errors", {
              sku: item.sku,
              quantity: item.quantity,
              userErrors: errors,
            });
            lines.push({
              sku: item.sku,
              delta: item.quantity,
              status: "user_error",
              inventoryItemId,
              messages: errors.map((e) => e.message),
            });
            continue;
          }

          summary.adjusted++;
          logger.info("stock_adjusted", {
            sku: item.sku,
            quantity: item.quantity,
            inventoryItemId,
          });
          lines.push({
            sku: item.sku,
            delta: item.quantity,
            status: "adjusted",
            inventoryItemId,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (err) {
          summary.userErrors++;
          const msg = String(err);
          logger.error("stock_adjust_error", {
            sku: item.sku,
            error: msg,
          });
          lines.push({
            sku: item.sku,
            delta: item.quantity,
            status: "exception",
            inventoryItemId,
            error: msg,
          });
        }
      }
    }

    return { ...summary, lines };
  }
}
