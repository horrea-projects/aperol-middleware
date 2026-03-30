import { connectLambda } from "@netlify/blobs";
import type { HandlerEvent } from "@netlify/functions";

/** Netlify injecte ce champ en prod (mode compatibilité Lambda) pour initialiser le client Blobs. */
type NetlifyBlobsHandlerEvent = HandlerEvent & { blobs?: string };

/**
 * À appeler au début des fonctions Netlify qui utilisent `@netlify/blobs` (`getStore`),
 * lorsque le runtime ne fournit pas `NETLIFY_BLOBS_CONTEXT` mais transmet les données via `event.blobs`.
 *
 * @see https://github.com/netlify/blobs — section « Lambda compatibility mode »
 */
export function bindNetlifyBlobsForLambda(event: HandlerEvent): void {
  const blobs = (event as NetlifyBlobsHandlerEvent).blobs;
  if (typeof blobs !== "string" || blobs.length === 0) return;
  connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
}
