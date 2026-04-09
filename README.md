# Middleware Shopify ↔ GetByrd (UK)

Middleware **serverless** qui synchronise l’entrepôt **UK** entre **Shopify** (Admin API) et **GetByrd** (WMS). Il tourne sur **Netlify** (Functions + page statique), sans base de données.

## Rôle

| Flux | Direction | Périmètre |
|------|-----------|-----------|
| **Stocks** | GetByrd → Shopify | Uniquement la **location UK** Shopify |

Les deltas de stock et le filtrage par entrepôt Byrd (`BYRD_WAREHOUSE_ID`) limitent les écarts entre WMS et Shopify.

## Architecture

```
public/index.html          → Dashboard (stocks, runs sync)
netlify/functions/        → Points d’entrée HTTP + crons
src/
  config.ts               → Construction de la config par cible (prod / staging)
  handlers/               → Handler partagé pour les sync planifiées
  jobs/                   → stockSync
  services/               → Shopify, Byrd, WMS (abstraction)
  utils/                  → HTTP, logs fichier, Slack
```

**Documentation plus détaillée** :

- [`docs/DEPLOY_NETLIFY.md`](./docs/DEPLOY_NETLIFY.md) — **déploiement sur Netlify** (build, variables, crons, checklist).
- [`docs/SCOPES_AND_ENV.md`](./docs/SCOPES_AND_ENV.md) — scopes Shopify, variables, **lancement auto + refresh token Dev Dashboard**.
- [`Explications.md`](./Explications.md) — comportement métier, risques, exploitation.

## Prérequis

- **Node.js** (LTS recommandé) et **npm**
- Compte **Netlify** pour le déploiement (ou exécution locale des fonctions avec l’outil Netlify CLI)
- **App Shopify personnalisée** avec les bons scopes (voir `docs/SCOPES_AND_ENV.md`)
- Compte **GetByrd** (clé / secret API)

## Installation

```bash
git clone <repo>
cd aperol-middleware
npm install
cp .env.example .env
# Renseigner .env (voir section Variables d’environnement)
```

### Vérification TypeScript

```bash
npm run build
```

Les fonctions Netlify sont bundlées au déploiement ; en local, utilisez **Netlify CLI** pour un comportement proche de la prod.

### Démarrage

1. **Racine du dépôt** : le fichier **`.env`** doit être à la racine (à côté de `netlify.toml`). Ne lance pas `netlify dev` depuis un sous-dossier.
2. **Charger les variables** : la CLI Netlify charge en principe automatiquement **`.env`** pour `netlify dev`. Commande habituelle :

```bash
npm install   # une fois
npm run dev
```

(`npm run dev` exécute `netlify dev`.)

3. **Si les fonctions ne « voient » pas les variables** (symptômes : config vide, erreurs bizarres) : dans **zsh** ou **bash**, forcer l’export puis lancer la CLI :

```bash
set -a
source .env
set +a
npx netlify dev
```

(`set -a` exporte toutes les variables définies pendant le `source` ; `set +a` désactive ce mode ensuite.)

4. **Erreur Shopify `401 Invalid API key`** : mauvais couple boutique / credentials. Vérifie `PROD_SHOPIFY_STORE_DOMAIN` + soit **`PROD_SHOPIFY_ADMIN_ACCESS_TOKEN`** soit **`PROD_SHOPIFY_CLIENT_ID` + `PROD_SHOPIFY_CLIENT_SECRET`** (voir `docs/SCOPES_AND_ENV.md`).

Ouvrez l’URL affichée par la CLI ; le dashboard est servi depuis `public/`.

## Variables d’environnement

Copiez **`.env.example`** vers **`.env`** et complétez. Résumé :

| Zone | Variables |
|------|-----------|
| **Shopify (prod)** | `PROD_SHOPIFY_STORE_DOMAIN`, `PROD_SHOPIFY_UK_LOCATION_ID`, et **soit** `PROD_SHOPIFY_ADMIN_ACCESS_TOKEN` **soit** `PROD_SHOPIFY_CLIENT_ID` + `PROD_SHOPIFY_CLIENT_SECRET` (rafraîchissement auto du jeton ~24 h). Repli : anciens `SHOPIFY_*`. |
| **Shopify (staging)** | Idem avec préfixe `STAGING_SHOPIFY_*` |
| **Byrd** | `BYRD_API_KEY`, `BYRD_API_SECRET`, `BYRD_WAREHOUSE_ID` (recommandé), `BYRD_BASE_URL` (optionnel) |
| **WMS générique** | `WMS_BASE_URL`, `WMS_API_KEY` (si pas Byrd) |
| **Staging Byrd / WMS** | `STAGING_BYRD_*` ou `STAGING_WMS_*` (optionnel ; sinon réutilisation des clés prod pour la lecture WMS) |
| **Exclusions SKU sync stock** | Via dashboard (champ par environnement) ; fallback possible via `PROD_SYNC_EXCLUDED_SKUS` (CSV) et `STAGING_SYNC_EXCLUDED_SKUS` (CSV) |
| **Slack** | `SLACK_WEBHOOK_URL` ; **`SLACK_NOTIFICATIONS=0`** pour tout couper ; **`SLACK_PER_RUN_REPORTS=0`** pour ne garder que le digest ; **`SLACK_DAILY_DIGEST=0`** pour couper le digest seul (voir [`docs/SCOPES_AND_ENV.md`](./docs/SCOPES_AND_ENV.md)) |
| **Dashboard** | `DASHBOARD_PASSWORD` (accès UI + API de lecture), optionnel `DASHBOARD_AUTH_SECRET` |
| **Logs fichier** | `LOG_FILE_PATH` (local ou si fichier accessible sur l’hôte) |

Ne commitez jamais `.env` ni les secrets.

## Déploiement (Netlify)

Guide pas à pas : **[`docs/DEPLOY_NETLIFY.md`](./docs/DEPLOY_NETLIFY.md)** (liaison du dépôt, commande de build optionnelle, variables **Production** vs prévisualisations, crons, vérifications post-déploiement).

En résumé : **publish** `public`, fonctions TypeScript bundlées par **esbuild** ; renseigner **toutes** les variables sensibles dans **Site configuration → Environment variables** ; crons `sync-uk` et `sync-uk-staging` dans [`netlify.toml`](./netlify.toml) (toutes les 10 minutes par défaut).

Si le staging Shopify n’est pas configuré (`STAGING_SHOPIFY_STORE_DOMAIN` vide), la fonction staging **se termine proprement** sans exécuter la sync.

## Fonctionnement de la synchronisation

1. **Stock** : lecture des stocks Byrd pour l’entrepôt cible → lecture des niveaux Shopify UK → calcul des **deltas** → ajustements GraphQL (`write_inventory` requis).

Un rapport peut être envoyé sur **Slack** après chaque run (prod ou staging selon la config).

## Dashboard

Url du site Netlify (racine) : en-tête avec **nom de domaine** Shopify (prod / staging), menu déroulant pour changer d’environnement, onglets **Stocks** et **Runs sync** (résumé succès/échecs par run, détail par SKU et suppression).

- Onglet **Slack** : activer la « priorité dashboard » pour piloter master / message après sync / digest **sans redéployer** (stocké en Blobs Netlify ou fichier local ; les variables d’environnement restent le repli si cette option est désactivée).
- Les appels passent `?target=prod|staging` ; côté serveur, une config dédiée est appliquée (**pas de mélange** des tokens entre prod et staging).
- Connexion avec **`DASHBOARD_PASSWORD`** : session **cookie HttpOnly** (pas de stockage du mot de passe dans le navigateur).
- **Débogage** : `DASHBOARD_DEBUG=1` dans l’env → logs `[dashboard-auth …]` dans la console des functions ; `GET /.netlify/functions/dashboard-debug` renvoie un JSON (cookie présent / valide, sans secret). Côté navigateur : ouvrir le dashboard avec `?dashdebug=1` pour tracer les `fetch` dans la console.

Fonctions utiles :

| Fonction | Usage |
|----------|--------|
| `dashboard-auth` | Connexion (mot de passe → cookie de session) |
| `dashboard-auth-info` | GET sans auth : indique si `DASHBOARD_PASSWORD` est configuré (debug session) |
| `dashboard-logout` | Déconnexion (efface le cookie) |
| `dashboard-debug` | JSON diagnostic si `DASHBOARD_DEBUG=1` |
| `dashboard-overview` | Aperçu agrégé (logs récents, etc.) — auth dashboard |
| `shopify-config-snapshot` | JSON diagnostic Shopify (auth + probes oauth/graphql) — cookie dashboard requis |
| `site-meta` | Domaines Shopify affichés (non secrets) |
| `stock-comparison` | Tableau Byrd vs Shopify UK |
| `sync-runs` | Historique des runs (GET liste, DELETE par `id`) — voir `SYNC_RUN_HISTORY_PATH` / Blobs |
| `sync-uk` / `sync-uk-staging` | Sync complète stocks (cron ou appel manuel) |
| `sync-uk-stock-now` | Sync stock seule (sans le reste du run complet) — auth dashboard |
| `sync-uk-stock-sku-now` | Sync stock pour un SKU — auth dashboard |
| `daily-slack-digest` | Rapport Slack **quotidien** — **cron uniquement** (pas d’URL HTTP fiable en prod) |
| `daily-slack-digest-manual` | Même rapport, **GET/POST HTTP** (tests, déclenchement à la main) ; secret optionnel `DAILY_DIGEST_HTTP_SECRET` — voir [`docs/SCOPES_AND_ENV.md`](./docs/SCOPES_AND_ENV.md) |
| `slack-settings` | **GET/PUT** réglages notifications Slack (priorité dashboard vs `.env`) — cookie dashboard requis |

## Scripts npm utiles

| Commande | Description |
|----------|-------------|
| `npm run build` | Compilation TypeScript (`dist/`) |
| `npm run shopify:auth-check` | Lit d’abord **`.env`** (priorité sur le shell), puis teste token statique ou `client_credentials`. |
| `npm run shopify:get-admin-token` | Génère un **nouveau** token via OAuth *client credentials* (app **Dev Dashboard** avec `CLIENT_ID` / `CLIENT_SECRET`) — voir encadré ci‑dessous. |
| `npm run shopify:get-admin-token:staging` | Idem pour le staging. |

### Shopify : auth Admin API

1. **Token statique** : app créée dans la boutique → **Admin API access token** dans `.env` / Netlify (`*_ADMIN_ACCESS_TOKEN`). Stable jusqu’à réinstallation ou rotation manuelle.
2. **Dev Dashboard (recommandé si tu n’as pas d’app admin boutique)** : renseigner **`CLIENT_ID` + `CLIENT_SECRET`** (+ domaine + location). Le middleware obtient un jeton via `client_credentials`, le met en **cache** et le **renouvelle** avant expiration (~24 h). Tu peux laisser **`_ADMIN_ACCESS_TOKEN` vide** sur Netlify.

Le script `npm run shopify:get-admin-token` affiche un jeton ponctuel (utile en debug) ; il n’est **pas** nécessaire de copier ce jeton en prod si `CLIENT_ID` / `SECRET` sont déjà dans l’env.

**Ordre conseillé :** `npm run shopify:auth-check` depuis la racine du dépôt (`.env` pris en compte automatiquement). Si 401 alors qu’un vieux `SHOPIFY_ADMIN_ACCESS_TOKEN` traîne dans le terminal : `unset SHOPIFY_ADMIN_ACCESS_TOKEN` ou ferme le shell.

## Structure des dossiers (aperçu)

```
aperol-middleware/
  README.md                 ← ce fichier
  Explications.md           ← détail métier / bonnes pratiques
  docs/DEPLOY_NETLIFY.md    ← déploiement Netlify
  docs/SCOPES_AND_ENV.md    ← scopes + liste des env
  netlify.toml
  package.json
  public/index.html
  netlify/functions/*.ts
  src/
```

## Licence et support

Projet interne **Horrea / Aperol** ; adapter selon votre politique de licence si le dépôt est public.

Pour toute évolution (scopes, nouveaux marchés, autre WMS), commencez par `Explications.md` et les services sous `src/services/`.
