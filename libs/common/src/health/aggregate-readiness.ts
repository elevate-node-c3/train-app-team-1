import type { AggregatedHealthReport } from '@app/contracts';

export const AGGREGATE_READINESS = Symbol('AGGREGATE_READINESS');

/**
 * Implemented by a service that answers for others. The gateway binds it; the
 * other six leave it unbound and report only themselves.
 *
 * Chosen by DI rather than by reading `process.env.APP`, which is how a shared
 * controller came to ask which service it was running in — and how all seven
 * came to build gRPC clients to the other six.
 */
export interface AggregateReadiness {
  aggregate(): Promise<AggregatedHealthReport>;
}
