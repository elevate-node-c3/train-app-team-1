import type { EventEnvelope } from '@app/contracts';

/** Values bound to `INSERT_OUTBOX_SQL`, in order. */
export interface OutboxAppendParams {
  id: string;
  eventType: string;
  eventVersion: number;
  routingKey: string;
  payload: unknown;
  correlationId: string;
  producer: string;
  occurredAt: string;
}

/** A row as the relay sees it, mapped out of the snake_case table. */
export interface OutboxRow {
  id: string;
  eventType: string;
  eventVersion: number;
  routingKey: string;
  payload: unknown;
  correlationId: string;
  producer: string;
  occurredAt: string;
  publishedAt: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
}

/**
 * The routing key is stored on the row, not derived at publish time. A future
 * rename of a payload field must not silently reroute rows that were written
 * under the old contract.
 */
export function appendParams(envelope: EventEnvelope): OutboxAppendParams {
  return {
    id: envelope.id,
    eventType: envelope.type,
    eventVersion: envelope.version,
    routingKey: envelope.type,
    payload: envelope.payload,
    correlationId: envelope.correlationId,
    producer: envelope.producer,
    occurredAt: envelope.occurredAt,
  };
}

export function rowFrom(params: OutboxAppendParams): OutboxRow {
  return {
    id: params.id,
    eventType: params.eventType,
    eventVersion: params.eventVersion,
    routingKey: params.routingKey,
    payload: params.payload,
    correlationId: params.correlationId,
    producer: params.producer,
    occurredAt: params.occurredAt,
    publishedAt: null,
    attemptCount: 0,
    nextAttemptAt: params.occurredAt,
    lastError: null,
  };
}

export function envelopeOf(row: OutboxRow): EventEnvelope {
  return {
    id: row.id,
    type: row.eventType,
    version: row.eventVersion,
    occurredAt: toIsoString(row.occurredAt),
    correlationId: row.correlationId,
    producer: row.producer,
    payload: row.payload,
  };
}

/** pg returns `timestamptz` as a Date; the envelope wants an ISO string. */
export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Maps one raw pg row (snake_case, Date values) into the relay's shape. */
export function fromDbRow(raw: Record<string, unknown>): OutboxRow {
  return {
    id: String(raw.id),
    eventType: String(raw.event_type),
    eventVersion: Number(raw.event_version),
    routingKey: String(raw.routing_key),
    payload: raw.payload,
    correlationId: String(raw.correlation_id),
    producer: String(raw.producer),
    occurredAt: toIsoString(raw.occurred_at as Date | string),
    publishedAt: raw.published_at
      ? toIsoString(raw.published_at as Date | string)
      : null,
    attemptCount: Number(raw.attempt_count),
    nextAttemptAt: toIsoString(raw.next_attempt_at as Date | string),
    lastError: raw.last_error == null ? null : (raw.last_error as string),
  };
}
