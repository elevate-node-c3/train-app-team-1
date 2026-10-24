/**
 * The statements are the design, so they live beside the adapter that runs
 * them and are exported for the schema-agreement test.
 */

export const INSERT_OUTBOX_SQL = `
  INSERT INTO outbox_event (
    id, event_type, event_version, routing_key, payload,
    correlation_id, producer, occurred_at
  )
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
`;

/**
 * `FOR UPDATE SKIP LOCKED` is the entire multi-instance story: a sibling relay
 * steps over the rows this one holds instead of blocking on them, so both make
 * progress on disjoint batches without a leader election.
 *
 * The publish happens inside this transaction, so the row lock is still held
 * when `markPublished` runs.
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

/**
 * Only `error.message` is stored — never the payload, which can contain a live
 * verification code.
 */
export const RECORD_OUTBOX_FAILURE_SQL = `
  UPDATE outbox_event
     SET attempt_count = attempt_count + 1,
         next_attempt_at = $2,
         last_error = $3
   WHERE id = $1
`;
