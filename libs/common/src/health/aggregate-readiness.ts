import type { AggregatedHealthReport } from '@app/contracts';

export const AGGREGATE_READINESS = Symbol('AGGREGATE_READINESS');

/**
 * Bound by the gateway only; other services report local health. DI selects
 * aggregation without checking `process.env.APP` in the shared controller.
 */
export interface AggregateReadiness {
  aggregate(): Promise<AggregatedHealthReport>;
}
