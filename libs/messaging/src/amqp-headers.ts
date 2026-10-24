export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const ATTEMPT_HEADER = 'x-attempt';
export const DEATH_REASON_HEADER = 'x-death-reason';

export type DeathReason =
  | 'invalid-payload'
  | 'unsupported-version'
  | 'retries-exhausted';

/**
 * Injects the correlation ID into AMQP headers so it travels with the message.
 *
 * The required id comes first on purpose: a defaulted parameter before a
 * required one is legal TypeScript but makes every call site read as if it were
 * optional, and a swapped pair of strings would type-check silently.
 */
export function injectCorrelationId(
  correlationId: string,
  headers: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...headers,
    [CORRELATION_ID_HEADER]: correlationId,
  };
}

/**
 * Extracts the correlation ID from incoming AMQP headers. amqplib can hand a
 * header value back as a `Buffer` when the publisher's encoding differs, so a
 * string-only check would silently drop correlation across that hop.
 */
export function extractCorrelationId(
  headers?: Record<string, unknown>,
): string | undefined {
  if (!headers) return undefined;
  const value = headers[CORRELATION_ID_HEADER];
  const text = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      : undefined;
  if (text && text.trim().length > 0) {
    return text;
  }
  return undefined;
}

/** A message's retry attempt count, carried across republishes. */
export function extractAttempt(headers?: Record<string, unknown>): number {
  const raw = headers?.[ATTEMPT_HEADER];
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  const parsed = typeof text === 'string' ? Number.parseInt(text, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
