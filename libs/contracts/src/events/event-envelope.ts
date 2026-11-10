/**
 * The shape every domain event travels in (§10.C). `EventLanguage` duplicates
 * `@app/common`'s `SupportedLanguage` to avoid a dependency cycle; a spec
 * asserts the two stay mutually assignable.
 */
export type EventLanguage = 'ar' | 'en';

export interface EventEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  /** Every consumer's idempotency key, so never derive it from the payload. */
  id: string;
  type: TType;
  /** Bumped only for a breaking payload change, never for an additive field. */
  version: number;
  /** ISO-8601 UTC, stamped in the producer's transaction, not at publish time. */
  occurredAt: string;
  /** A field, not just a header: CLS does not survive an async hop. */
  correlationId: string;
  /** Producing service name, e.g. 'identity'. */
  producer: string;
  payload: TPayload;
}

/** Drives the contract test's deletion sweep. Shrinking it is a contract change. */
export const ENVELOPE_REQUIRED_KEYS = [
  'id',
  'type',
  'version',
  'occurredAt',
  'correlationId',
  'producer',
  'payload',
] as const satisfies readonly (keyof EventEnvelope)[];

/**
 * The envelope only; the payload is each consumer's parser's job. Not
 * `class-validator`, because an unreadable envelope and an unknown version are
 * two different dead-letter reasons.
 */
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
