# Scopes Shopify & variables d’environnement

## Scopes Shopify pour le middleware

Pour que le middleware puisse **lire et écrire** les stocks ainsi que **créer des fulfillments** pour la location UK, l’app personnalisée Shopify doit avoir au minimum les scopes suivants.

### À avoir absolument

| Scope | Usage |
|-------|--------|
| `read_inventory` | Lire les niveaux de stock et les `inventory_item_id` (mapping SKU). |
| **`write_inventory`** | **Mettre à jour les quantités** pour la location UK (sync stock Byrd → Shopify). |
| `read_orders` | Récupérer les commandes et les fulfillments existants (idempotence). |
| `read_products` | Résoudre SKU → `inventory_item_id` (produits / variants). |
| `read_merchant_managed_fulfillment_orders` ou `read_assigned_fulfillment_orders` | Lire les fulfillment orders assignés à la location UK. |
| **`write_merchant_managed_fulfillment_orders`** (ou équivalent write fulfillments) | **Créer les fulfillments** quand le WMS signale un envoi (tracking, transporteur). |

Sans `write_inventory`, les stocks ne peuvent pas être mis à jour. Sans le scope d’écriture sur les fulfillments, les expéditions ne peuvent pas être créées dans Shopify.

### Scopes que vous avez listés — à garder ou pas

- **À garder** (utilisés ou utiles) :  
  `read_assigned_fulfillment_orders`, `read_inventory`, `read_merchant_managed_fulfillment_orders`, `read_orders`, `read_products`.  
  Et surtout : **`write_inventory`** et le scope **write** pour les fulfillments (ex. `write_merchant_managed_fulfillment_orders` si disponible dans votre version d’API).

- **Optionnels pour ce middleware** (vous pouvez les retirer si vous voulez limiter les droits) :  
  `read_draft_orders`, `read_inventory_shipments`, `read_inventory_shipments_received_items`, `read_inventory_transfers`, `write_order_edits`, `read_product_feeds`, `read_product_listings`, `customer_read_draft_orders`, `customer_read_orders`, `unauthenticated_read_*`.  
  Ils ne sont pas nécessaires pour la sync stock UK et la création de fulfillments.

En résumé : vérifiez que **`write_inventory`** et le scope d’écriture des fulfillments (ex. **`write_merchant_managed_fulfillment_orders`**) sont bien cochés ; le reste de votre liste couvre déjà la lecture.

---

## Variables d’environnement

### Shopify

| Variable | Description |
|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Domaine du shop (ex. `votre-boutique.myshopify.com`). |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Token d’accès Admin API (app personnalisée). |
| `SHOPIFY_UK_LOCATION_ID` | ID numérique de la **location UK** (entrepôt) dans Shopify. |

### Byrd (WMS)

Documentation : [Byrd Developer Docs](https://developers.getbyrd.com/docs/getting-product-details).

| Variable | Description |
|----------|-------------|
| `BYRD_API_KEY` | Clé API (ex. `bk_...`). **Ne pas commiter** — à mettre uniquement dans les variables d’environnement Netlify. |
| `BYRD_API_SECRET` | Secret API (ex. `bs_...`). **Ne pas commiter** — idem. |
| `BYRD_BASE_URL` | (Optionnel) Base de l’API. Défaut : `https://api.getbyrd.com`. |
| `BYRD_WAREHOUSE_ID` | (Optionnel) ID de l’entrepôt UK dans Byrd. Si un seul entrepôt, il peut être déduit. |

L’authentification Byrd se fait via **JWT** : le middleware appelle `POST /v2/login` avec `username` = `BYRD_API_KEY` et `password` = `BYRD_API_SECRET`, puis utilise le token dans l’en-tête `Authorization: Bearer <token>` pour les appels produits et expéditions.

### Redis (optionnel mais recommandé)

Pour le verrou d’exécution et les logs du dashboard :

| Variable | Description |
|----------|-------------|
| `REDIS_REST_URL` | URL REST de la base (ex. Upstash). |
| `REDIS_REST_TOKEN` | Token d’authentification. |

### Sync

| Variable | Description |
|----------|-------------|
| `SHIPMENT_WINDOW_MINUTES` | (Optionnel) Fenêtre en minutes pour récupérer les expéditions depuis la dernière sync. Défaut : `120`. |

---

## Dashboard

- **URL** : après déploiement Netlify, la page d’accueil du site (ex. `https://votre-site.netlify.app/`) affiche le dashboard.
- **Logs** : si Redis est configuré, les derniers logs de sync sont affichés (sinon la section reste vide).
- **Comparaison des stocks** : tableau Byrd (WMS) vs Shopify (location UK) par SKU, avec indicateur « Aligné » (Oui/Non).
