/**
 * The shape every domain event travels in (§10.C).
 *
 * `EventLanguage` is duplicated from `@app/common`'s `SupportedLanguage`
 * rather than imported: `@app/common` imports `@app/contracts`, so the reverse
 * edge would be a dependency cycle. `test/unit/event-envelope.spec.ts` asserts
 * the two stay mutually assignable, so they cannot drift in silence.
 */
export type EventLanguage = 'ar' | 'en';

export interface EventEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  /** Globally unique. Minted in the producer's transaction and used by every
   *  consumer as its idempotency key, so it must never be derived from the
   *  payload — two genuinely distinct events would collide and one would be
   *  silently deduplicated away. */
  id: string;
  type: TType;
  /** Integer, bumped only for a breaking payload change. An additive field
   *  does not bump it: consumers check the fields they need rather than
   *  rejecting unknown ones. */
  version: number;
  /** ISO-8601 UTC, stamped inside the producer's transaction rather than at
   *  publish time, so a latency measurement starts when the thing happened. */
  occurredAt: string;
  /** Carried as a first-class field, not only as a message header: an async
   *  hop is exactly where CLS does not reach and exactly where a request most
   *  needs tracing. */
  correlationId: string;
  /** Producing service name, e.g. 'identity'. */
  producer: string;
  payload: TPayload;
}

/**
 * Drives the contract test's one-field-at-a-time deletion sweep. Shrinking
 * this list is a contract change and shows up in review.
 */
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
 * A structural check on the envelope only — it says nothing about the payload,
 * which is each consumer's own parser's job. Deliberately not `class-validator`:
 * a consumer needs to tell an unreadable envelope apart from an unknown
 * version, and those are two different dead-letter reasons.
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
