/** Short, capped retries drain quickly after recovery; attemptCount already includes the failure. */
export const RELAY_BACKOFF_BASE_MS = 250;
export const RELAY_BACKOFF_MAX_MS = 5000;

export function relayBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(RELAY_BACKOFF_BASE_MS * 2 ** exponent, RELAY_BACKOFF_MAX_MS);
}
