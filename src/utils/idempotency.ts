import { logger } from "./logger";

export function isDuplicateTrackingNumber(existingTrackingNumbers: string[], candidate: string): boolean {
  const normalizedCandidate = candidate.trim();
  const duplicate = existingTrackingNumbers.some((t) => t.trim() === normalizedCandidate);
  if (duplicate) {
    logger.info("fulfillment_skipped_duplicate", { tracking_number: normalizedCandidate });
  }
  return duplicate;
}

