# Explications du middleware Shopify ↔ GetByrd (UK)

Ce document explique comment fonctionne la liaison **stock** UK, ce qui est déjà en place, et les protections à appliquer pour limiter les mises à jour de stock non voulues. La synchronisation des **expéditions / fulfillments** vers Shopify a été **retirée** du code.

---

## 1) Objectif métier

Le middleware synchronise uniquement l’entrepôt UK entre :

- **Shopify** (location UK dédiée)
- **GetByrd** (WMS / logisticien)

**Flux actif** : **stock** GetByrd → Shopify (location UK uniquement).

Le tout tourne en **serverless** (Netlify Functions), sans base SQL. **Déploiement** : voir [`docs/DEPLOY_NETLIFY.md`](./docs/DEPLOY_NETLIFY.md).

---

## 2) Architecture actuelle (ce qui tourne déjà)

### 2.1 Exécution

- Fonctions planifiées : `netlify/functions/sync-uk.ts` (prod), `netlify/functions/sync-uk-staging.ts` (staging).
- Fréquence : [`netlify.toml`](./netlify.toml) (cron, typiquement toutes les 10 minutes).
- Pas de verrou distribué : deux invocations cron peuvent se chevaucher si le runtime le permet.

### 2.2 Services

- `src/services/shopifyService.ts`  
  Niveaux d’inventaire UK, mapping SKU → article d’inventaire, ajustements (`inventoryAdjustQuantities`).
- `src/services/wmsService.ts`  
  Abstraction WMS ; branche GetByrd si identifiants Byrd présents.
- `src/services/byrdClient.ts`  
  Auth JWT GetByrd (`/v2/login`), produits / stock (`/v2/warehouse/products`).

### 2.3 Dashboard et API HTTP

- `public/index.html` — interface Stocks / Runs sync.
- Exemples d’endpoints : `stock-comparison`, `sync-runs`, `dashboard-auth`, `shopify-config-snapshot` (diagnostic, avec session dashboard si requis). Liste complète : [`README.md`](./README.md).

---

## 3) Variables d’environnement critiques

### Shopify

- **Prod** : `PROD_SHOPIFY_STORE_DOMAIN`, `PROD_SHOPIFY_UK_LOCATION_ID`, et **soit** `PROD_SHOPIFY_ADMIN_ACCESS_TOKEN` **soit** `PROD_SHOPIFY_CLIENT_ID` + `PROD_SHOPIFY_CLIENT_SECRET` (app Dev Dashboard installée sur la boutique). Repli historique : préfixes `SHOPIFY_*` pour certains champs (voir [`docs/SCOPES_AND_ENV.md`](./docs/SCOPES_AND_ENV.md)).
- **Staging** : `STAGING_SHOPIFY_*` (même logique, sans mélange avec la prod).

### GetByrd

- `BYRD_API_KEY`, `BYRD_API_SECRET`, `BYRD_WAREHOUSE_ID` (recommandé pour figer l’entrepôt UK).

### Dashboard

- `DASHBOARD_PASSWORD` (et secrets associés si utilisés) — à définir aussi sur **Netlify**, pas seulement en local.

Liste exhaustive et priorités token / OAuth : [`docs/SCOPES_AND_ENV.md`](./docs/SCOPES_AND_ENV.md).

---

## 4) Scopes Shopify minimaux recommandés

Voir `docs/SCOPES_AND_ENV.md` : en pratique `read_inventory`, `write_inventory`, `read_locations`, `read_products`.

---

## 5) Comment marche la sync stock (détail)

1. GetByrd retourne les stocks par produit (par entrepôt).
2. Le middleware ne prend que l’entrepôt cible (`BYRD_WAREHOUSE_ID`).
3. Le middleware lit les quantités actuelles Shopify pour la location UK.
4. Il calcule un delta (Byrd − Shopify) puis applique uniquement les deltas non nuls.
5. Les appels sont batchés et journalisés.

### Protection clé

- Si `BYRD_WAREHOUSE_ID` est défini, on ne bascule pas sur un autre entrepôt.
- Aucune mise à jour hors location UK.

---

## 6) (Retiré) Sync expéditions

L’ancienne synchronisation des expéditions GetByrd vers des fulfillments Shopify a été supprimée du dépôt.

---

## 7) Ce qu’il manque encore pour une prod « blindée »

### 7.1 Gouvernance des identifiants (très important)

- Ne jamais exposer de secrets dans logs, tickets, chat, captures.
- Rotation périodique :
  - `PROD_SHOPIFY_ADMIN_ACCESS_TOKEN` / `STAGING_SHOPIFY_ADMIN_ACCESS_TOKEN` (si utilisés)
  - secrets **Dev Dashboard** (`*_CLIENT_SECRET`) en cas de fuite
  - `BYRD_API_KEY` / `BYRD_API_SECRET`
  - `DASHBOARD_PASSWORD` (si utilisé)

### 7.2 Retry intelligents

Actuel : retry HTTP général.

À renforcer : backoff exponentiel + jitter, distinction 4xx / 5xx, pas de retry sur erreurs fonctionnelles définitives.

### 7.3 Observabilité

- Historique **Runs sync** (dashboard) + Slack optionnel.
- Métriques utiles : ajustements stock appliqués / erreurs API.

### 7.4 Tests de non-régression

- Cas entrepôt Byrd inconnu → quantité 0 + avertissement.
- Cas token Shopify invalide → échec explicite.

---

## 8) Risques principaux et prévention

### Risque A : mise à jour stock hors UK

**Prévention** : location ID Shopify forcée dans chaque mutation ; entrepôt Byrd forcé via `BYRD_WAREHOUSE_ID` ; tests anti-régression.

### Risque B : scopes ou token incomplets

**Symptômes** : inventaire illisible, accès refusé.

**Prévention** : `npm run shopify:auth-check` ; vérifier les scopes avant mise en prod.

### Risque C : double exécution cron

**Prévention** : ajuster la fréquence Netlify ou introduire un verrou externe si nécessaire ; surveiller les logs Netlify des fonctions.

---

## 9) Procédure d’exploitation en cas d’incident

1. **Geler la sync** — désactiver temporairement le cron Netlify concerné si besoin.
2. **Diagnostiquer** — journaux Netlify des fonctions ; côté métier, historique **Runs sync** dans le dashboard ; `stock-comparison`.
3. **Vérifier credentials / scopes** — `npm run shopify:auth-check` ; `shopify-config-snapshot` en environnement déployé (voir doc scopes/env).
4. **Vérifier le ciblage UK** — `PROD_SHOPIFY_*` / `STAGING_SHOPIFY_*` (dont `*_UK_LOCATION_ID`), `BYRD_WAREHOUSE_ID`.
5. **Corriger et relancer** — réactiver le cron ; surveiller 2–3 cycles.

---

## 10) Bonnes pratiques sécurité liaison Shopify / GetByrd

- Principe du moindre privilège (scopes minimaux).
- Secrets uniquement en variables d’environnement (jamais dans git).
- Rotation régulière des identifiants.
- Journalisation sans secrets.
- Timeouts / retries contrôlés.
- Piste d’audit (qui a fait quoi et quand).

---

## 11) Checklist pré-prod

- [ ] Scopes Shopify complets et vérifiés.
- [ ] Auth Shopify valide : token statique **ou** OAuth Dev Dashboard (`CLIENT_ID` + `SECRET`, app installée sur le bon `*.myshopify.com`).
- [ ] `PROD_SHOPIFY_UK_LOCATION_ID` (et staging si utilisé) valides.
- [ ] `BYRD_WAREHOUSE_ID` valide.
- [ ] Variables renseignées sur **Netlify** pour l’environnement production (voir [`docs/DEPLOY_NETLIFY.md`](./docs/DEPLOY_NETLIFY.md)).
- [ ] Dashboard OK (stocks, runs sync).
- [ ] Vérification « aucun impact hors UK » (location Shopify + entrepôt Byrd).

---

## 12) Conclusion

La base est solide : architecture légère, séparation claire, dashboard de contrôle.

Pour renforcer la production :

1. Verrouiller scopes et credentials.
2. Renforcer idempotence / observabilité.
3. Ajouter les tests anti-régression critiques.
4. Formaliser la procédure incident.

Cela réduit fortement le risque d’écarts Byrd / Shopify ou de mises à jour hors périmètre UK.
