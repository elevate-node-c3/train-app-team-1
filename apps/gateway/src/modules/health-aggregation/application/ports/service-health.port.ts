import type { AggregatedHealthReport } from '@app/contracts';

export const SERVICE_HEALTH = Symbol('SERVICE_HEALTH');

/**
 * Collecting health from the other six services is network I/O, so the
 * use-case depends on this interface rather than on the gRPC client that
 * implements it. That is what lets the use-case be tested with a two-line fake
 * instead of six live services.
 */
export interface ServiceHealthPort {
  aggregate(): Promise<AggregatedHealthReport>;
}
