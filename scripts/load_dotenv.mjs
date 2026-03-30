/**
 * Lit `.env` à la racine du cwd (sans dépendance dotenv).
 * Les clés du fichier passent **avant** process.env pour reproduire le comportement
 * attendu en local (le projet prime sur un vieux export shell).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @returns {Record<string, string>}
 */
export function loadDotEnvFile(cwd = process.cwd()) {
  const p = resolve(cwd, ".env");
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  /** @type {Record<string, string>} */
  const out = {};
  for (let line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Première valeur non vide : fichier .env puis variables d’environnement.
 * @param {Record<string, string>} fileEnv
 * @param {string[]} keys
 */
export function envFirstFromFileThenProcess(fileEnv, ...keys) {
  for (const key of keys) {
    const fromFile = fileEnv[key];
    if (fromFile != null && String(fromFile).trim() !== "") return String(fromFile).trim();
    const v = process.env[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * Token Admin statique pour les scripts : aligné sur une config « Dev Dashboard » dans `.env`.
 *
 * - Si une clé `*_ADMIN_ACCESS_TOKEN` est **présente** dans le fichier (même vide) → on n’utilise
 *   pas le shell pour contourner une valeur explicite.
 * - Si **aucune** de ces clés n’est dans le fichier mais `CLIENT_ID` prod/staging y est défini →
 *   on retourne "" (forcer `client_credentials`) et **on ignore** un vieux export shell — c’est le
 *   cas typique : `.env` sans ligne token + terminal pollué par `SHOPIFY_ADMIN_ACCESS_TOKEN`.
 *
 * @param {Record<string, string>} fileEnv
 * @param {boolean} isStaging
 */
export function resolveShopifyStaticAdminToken(fileEnv, isStaging) {
  const tokenKeys = isStaging
    ? ["STAGING_SHOPIFY_ADMIN_ACCESS_TOKEN"]
    : ["PROD_SHOPIFY_ADMIN_ACCESS_TOKEN", "SHOPIFY_ADMIN_ACCESS_TOKEN"];

  for (const key of tokenKeys) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, key)) {
      const v = fileEnv[key];
      return v != null && String(v).trim() !== "" ? String(v).trim() : "";
    }
  }

  const oauthDeclaredInFile = isStaging
    ? Boolean(fileEnv.STAGING_SHOPIFY_CLIENT_ID?.trim())
    : Boolean(
        fileEnv.PROD_SHOPIFY_CLIENT_ID?.trim() || fileEnv.SHOPIFY_CLIENT_ID?.trim(),
      );

  if (oauthDeclaredInFile) return "";

  for (const key of tokenKeys) {
    const v = process.env[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
