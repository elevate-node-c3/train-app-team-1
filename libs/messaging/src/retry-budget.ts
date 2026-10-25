/**
 * arithmetic, as executable constants.
 *
 * `pollIntervalMs + attempts × handlerTimeoutMs + sum(retryDelays)` is the
 * worst case from issuance to an accepted email. Publish/confirm/transit is an
 * estimate, not a bound, so it is deliberately outside the inequality and
 * absorbed by the headroom. A broker outage moves the clock start to recovery
 * and is a separate availability statement.
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
 * The most the relay may wait between polls, given the documented consumer
 * policy, less one millisecond for the strict `<` below.
 *
 * Identity owns the poll interval, and this is the only part of the budget it
 * can check locally: the attempts and the delays are notification's variables
 * and never reach identity's process. Derived rather than written down, so
 * retuning the consumer moves this bound with it.
 */
export const MAX_RELAY_POLL_INTERVAL_MS =
  BUDGET_MS -
  worstCaseDeliveryMs({
    pollIntervalMs: 0,
    handlerTimeoutMs: EVENT_HANDLER_TIMEOUT_MS,
    retryDelaysMs: EVENT_RETRY_DELAYS_MS,
  }) -
  1;

/**
 * Throws when the configured worst case no longer fits. The `<` is
 * deliberate: equality would leave zero headroom for publish, confirm and
 * transit, which the arithmetic does not bound.
 */
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
