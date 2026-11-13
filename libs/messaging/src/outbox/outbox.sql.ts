/** Exported SQL lets tests check schema and adapter agreement. */

export const INSERT_OUTBOX_SQL = `
  INSERT INTO outbox_event (
    id, event_type, event_version, routing_key, payload,
    correlation_id, producer, occurred_at
  )
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
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
     SET published_at = now(), last_error = NULL
   WHERE id = $1
`;

/** Store error text only, never a payload with a live verification code. */
export const RECORD_OUTBOX_FAILURE_SQL = `
  UPDATE outbox_event
     SET attempt_count = attempt_count + 1,
         next_attempt_at = $2,
         last_error = $3
   WHERE id = $1
`;
