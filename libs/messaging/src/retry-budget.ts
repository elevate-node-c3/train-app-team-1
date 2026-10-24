/**
 * BR-03's arithmetic, as executable constants.
 *
 * `pollIntervalMs + attempts × handlerTimeoutMs + sum(retryDelays)` is the
 * worst case from issuance to an accepted email. Publish/confirm/transit is an
 * estimate, not a bound, so it is deliberately outside the inequality and
 * absorbed by the headroom. A broker outage moves the clock start to recovery
 * and is a separate availability statement.
 */
export const BR03_BUDGET_MS = 30_000;

export const OUTBOX_POLL_INTERVAL_MS = 500;
export const EVENT_HANDLER_TIMEOUT_MS = 3000;
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000];

export interface DeliveryBudgetConfig {
  pollIntervalMs: number;
  handlerTimeoutMs: number;
  retryDelaysMs: readonly number[];
}

/** A first attempt plus one per delay. */
export function maxDeliveryAttempts(
  retryDelaysMs: readonly number[],
): number {
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
 * Throws when the configured worst case no longer fits BR-03. The `<` is
 * deliberate: equality would leave zero headroom for publish, confirm and
 * transit, which the arithmetic does not bound.
 */
export function assertDeliveryBudget(config: DeliveryBudgetConfig): void {
  const worst = worstCaseDeliveryMs(config);
  if (worst >= BR03_BUDGET_MS) {
    throw new Error(
      `BR-03 budget exceeded: worst case ${worst}ms must be < ${BR03_BUDGET_MS}ms ` +
        `(poll ${config.pollIntervalMs}ms, ` +
        `${maxDeliveryAttempts(config.retryDelaysMs)} attempts × ${config.handlerTimeoutMs}ms, ` +
        `delays ${config.retryDelaysMs.join(',')}ms)`,
    );
  }
}
