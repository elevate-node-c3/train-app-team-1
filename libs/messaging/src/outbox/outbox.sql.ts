/** Exported SQL lets tests check schema and adapter agreement. */

export const INSERT_OUTBOX_SQL = `
  INSERT INTO outbox_event (
    id, event_type, event_version, routing_key, payload,
    correlation_id, producer, occurred_at
  )
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
`;

export const INSERT_OUTBOX_BATCH_SQL = `
  INSERT INTO outbox_event (
    id, event_type, event_version, routing_key, payload,
    correlation_id, producer, occurred_at
  )
  SELECT id, "eventType", "eventVersion", "routingKey", payload,
         "correlationId", producer, "occurredAt"
    FROM jsonb_to_recordset($1::jsonb) AS events (
      id uuid, "eventType" text, "eventVersion" integer, "routingKey" text,
      payload jsonb, "correlationId" text, producer text, "occurredAt" timestamptz
    )
`;

/**
 * SKIP LOCKED lets relays process separate batches without waiting for each other.
 * Hold the row lock through publication and marking within the same transaction.
 */
export const CLAIM_OUTBOX_SQL = `
  SELECT id, event_type, event_version, routing_key, payload,
         correlation_id, producer, occurred_at, published_at,
         attempt_count, next_attempt_at, last_error
    FROM outbox_event
   WHERE published_at IS NULL
     AND next_attempt_at <= now()
   ORDER BY occurred_at, id
   LIMIT $1
   FOR UPDATE SKIP LOCKED
`;

export const MARK_OUTBOX_PUBLISHED_SQL = `
  UPDATE outbox_event
     SET published_at = clock_timestamp(), last_error = NULL
   WHERE id = $1
`;

export const MARK_OUTBOX_BATCH_PUBLISHED_SQL = `
  UPDATE outbox_event
     SET published_at = clock_timestamp(), last_error = NULL
   WHERE id = ANY($1::uuid[]) AND published_at IS NULL
`;

/** Store error text only, never a payload with a live verification code. */
export const RECORD_OUTBOX_FAILURE_SQL = `
  UPDATE outbox_event
     SET attempt_count = attempt_count + 1,
         next_attempt_at = clock_timestamp() + ($2::double precision * interval '1 millisecond'),
         last_error = $3
   WHERE id = $1
`;
