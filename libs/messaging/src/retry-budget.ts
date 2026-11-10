/**
 * The delivery budget, as executable constants. The worst case from issuance to
 * an accepted email is `pollIntervalMs + attempts × handlerTimeoutMs +
 * sum(retryDelays)`. Publish, confirm and transit are estimates, not bounds, so
 * they sit outside the inequality and are absorbed by the headroom.
 */
export const BUDGET_MS = 30_000;

export const OUTBOX_POLL_INTERVAL_MS = 500;
export const EVENT_HANDLER_TIMEOUT_MS = 3000;
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000];

export interface DeliveryBudgetConfig {
  pollIntervalMs: number;
  handlerTimeoutMs: number;
  retryDelaysMs: readonly number[];
}

/** A first attempt plus one per delay. */
export function maxDeliveryAttempts(retryDelaysMs: readonly number[]): number {
  return retryDelaysMs.length + 1;
}

export function worstCaseDeliveryMs(config: DeliveryBudgetConfig): number {
  const retries = config.retryDelaysMs.reduce(
    (total, delay) => total + delay,
    0,
  );
  return (
    config.pollIntervalMs +
    maxDeliveryAttempts(config.retryDelaysMs) * config.handlerTimeoutMs +
    retries
  );
}

/**
 * The most the relay may wait between polls, less 1ms for the strict `<`. It is
 * the only part of the budget identity can check locally. Derived, not written
 * down, so retuning the consumer moves this bound with it.
 */
export const MAX_RELAY_POLL_INTERVAL_MS =
  BUDGET_MS -
  worstCaseDeliveryMs({
    pollIntervalMs: 0,
    handlerTimeoutMs: EVENT_HANDLER_TIMEOUT_MS,
    retryDelaysMs: EVENT_RETRY_DELAYS_MS,
  }) -
  1;

/** Strict `<`: equality leaves no headroom for publish, confirm and transit. */
export function assertDeliveryBudget(config: DeliveryBudgetConfig): void {
  const worst = worstCaseDeliveryMs(config);
  if (worst >= BUDGET_MS) {
    throw new Error(
      `budget exceeded: worst case ${worst}ms must be < ${BUDGET_MS}ms ` +
        `(poll ${config.pollIntervalMs}ms, ` +
        `${maxDeliveryAttempts(config.retryDelaysMs)} attempts × ${config.handlerTimeoutMs}ms, ` +
        `delays ${config.retryDelaysMs.join(',')}ms)`,
    );
  }
}
