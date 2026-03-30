/**
 * Charge `.env` à la racine du dépôt quand les variables sont absentes ou vides.
 *
 * - Sous `netlify dev`, `process.cwd()` ou l’env peut ne pas inclure le `.env` ; une clé peut aussi
 *   exister **vide** (site Netlify lié) et `dotenv` par défaut ne la remplace pas — on complète dans ce cas.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

function findDotEnvPath(): string | null {
  const tried = new Set<string>();
  const check = (abs: string): string | null => {
    const n = path.normalize(abs);
    if (tried.has(n)) return null;
    tried.add(n);
    try {
      if (fs.existsSync(n) && fs.statSync(n).isFile()) return n;
    } catch {
      /* ignore */
    }
    return null;
  };

  let cur = process.cwd();
  for (let i = 0; i < 10; i++) {
    const hit = check(path.join(cur, ".env"));
    if (hit) return hit;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  let dir = __dirname;
  for (let i = 0; i < 14; i++) {
    const hit = check(path.join(dir, ".env"));
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Recharge `.env` si besoin : complète les clés absentes ou vides (ex. site Netlify lié avec secret vide). */
export function ensureLocalEnvLoaded(): void {
  const envPath = findDotEnvPath();
  if (!envPath) return;

  try {
    const raw = fs.readFileSync(envPath);
    const parsed = parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      const cur = process.env[key];
      if (cur === undefined || cur === "") {
        process.env[key] = value;
      }
    }
  } catch {
    /* ignore */
  }
}

ensureLocalEnvLoaded();
