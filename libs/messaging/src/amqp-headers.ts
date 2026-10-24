export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Injects correlation ID into AMQP headers so that it travels with published events.
 */
export function injectCorrelationId(
  headers: Record<string, unknown> = {},
  correlationId: string,
): Record<string, unknown> {
  return {
    ...headers,
    [CORRELATION_ID_HEADER]: correlationId,
  };
}

/**
 * Extracts correlation ID from incoming AMQP message headers.
 */
export function extractCorrelationId(
  headers?: Record<string, unknown>,
): string | undefined {
  if (!headers) return undefined;
  const val = headers[CORRELATION_ID_HEADER];
  if (typeof val === 'string' && val.trim().length > 0) {
    return val;
  }
  return undefined;
}
