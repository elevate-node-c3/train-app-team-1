/**
 * Claim in one SQL statement so fresh duplicates have one winner.
 * Redelivery bypasses the old lease so a retry is not skipped as a duplicate.
 */
export const CLAIM_PROCESSED_EVENT_SQL = `
  INSERT INTO processed_event (event_id, event_type, status, attempt_count, claimed_at)
  VALUES ($1, $2, 'processing', 1, now())
  ON CONFLICT (event_id) DO UPDATE
     SET status = 'processing',
         attempt_count = processed_event.attempt_count + 1,
         claimed_at = now()
   WHERE processed_event.status = 'failed'
      OR (processed_event.status = 'processing'
          AND ($3::boolean
               OR processed_event.claimed_at < now() - ($4 * interval '1 second')))
  RETURNING attempt_count
`;

export const MARK_PROCESSED_EVENT_HANDLED_SQL = `
  UPDATE processed_event
     SET status = 'handled', handled_at = now(), skip_reason = NULL, last_error = NULL
   WHERE event_id = $1
`;

export const MARK_PROCESSED_EVENT_SKIPPED_SQL = `
  UPDATE processed_event
     SET status = 'skipped', handled_at = now(), skip_reason = $2, last_error = NULL
   WHERE event_id = $1
`;

/** Release failed claims before retry publication so the next attempt is not skipped. */
export const MARK_PROCESSED_EVENT_FAILED_SQL = `
  UPDATE processed_event
     SET status = 'failed', last_error = $2
   WHERE event_id = $1
     AND status = 'processing'
`;
