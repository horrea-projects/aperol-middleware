/**
 * Indique si les données doivent être stockées via **Netlify Blobs** plutôt que sous `data/…`.
 *
 * Les fonctions Netlify s’exécutent sur Lambda (`/var/task` en pratique **non inscriptible** pour
 * créer `data/`). `NETLIFY === "true"` n’est pas toujours posé dans ce runtime, alors on détecte
 * aussi `AWS_LAMBDA_FUNCTION_NAME`.
 *
 * Sous `netlify dev`, `NETLIFY_DEV=true` : on garde le stockage **fichier** local sauf si une
 * variable force le chemin explicite.
 */
export function shouldUseNetlifyBlobs(unlessPathEnvKey: string): boolean {
  if (String(process.env[unlessPathEnvKey] ?? "").trim()) return false;
  if ((process.env.NETLIFY_DEV ?? "").toLowerCase() === "true") return false;
  const netlify = (process.env.NETLIFY ?? "").toLowerCase();
  if (netlify === "true" || netlify === "1" || netlify === "yes") return true;
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}
