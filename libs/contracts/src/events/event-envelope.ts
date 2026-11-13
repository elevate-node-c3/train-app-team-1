/**
 * Share one event shape without importing common, to avoid cycles.
 * Tests keep EventLanguage compatible with the HTTP language type.
 */
export type EventLanguage = 'ar' | 'en';

export interface EventEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  /** Use the event ID for deduplication, never a payload-derived key. */
  id: string;
  type: TType;
  /** Bumped only for a breaking payload change, never for an additive field. */
  version: number;
  /** UTC time from the producer's transaction, not publication. */
  occurredAt: string;
  /** Carry tracing in the body too; async work can lose context. */
  correlationId: string;
  /** Producing service name, e.g. 'identity'. */
  producer: string;
  payload: TPayload;
}

/** Removing a required key changes the contract. */
export const ENVELOPE_REQUIRED_KEYS = [
  'id',
  'type',
  'version',
  'occurredAt',
  'correlationId',
  'producer',
  'payload',
] as const satisfies readonly (keyof EventEnvelope)[];

/** Validate envelope fields only; consumers own payload validation. */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.type === 'string' &&
    candidate.type.length > 0 &&
    typeof candidate.version === 'number' &&
    Number.isInteger(candidate.version) &&
    typeof candidate.occurredAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.occurredAt)) &&
    typeof candidate.correlationId === 'string' &&
    typeof candidate.producer === 'string' &&
    candidate.producer.length > 0 &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  );
}
