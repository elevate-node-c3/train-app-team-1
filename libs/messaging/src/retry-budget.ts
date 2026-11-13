/**
 * Budgeted time = poll + attempts * handler timeout + total retry delays.
 * Publish, broker confirmation, and transit use the remaining headroom.
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
 * Derive identity's poll limit from the consumer budget.
 * Subtract 1ms so the total stays strictly below the limit.
 */
export const MAX_RELAY_POLL_INTERVAL_MS =
  BUDGET_MS -
  worstCaseDeliveryMs({
    pollIntervalMs: 0,
    handlerTimeoutMs: EVENT_HANDLER_TIMEOUT_MS,
    retryDelaysMs: EVENT_RETRY_DELAYS_MS,
  }) -
  1;

/** Use < so publishing, confirmation, and transit still have headroom. */
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
