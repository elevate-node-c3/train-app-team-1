/**
 * One statement, one round trip, no read-then-write window.
 *
 * Two instances receiving the same fresh duplicate: neither is a redelivery and
 * the lease is fresh, so exactly one `INSERT` wins and the other's `DO UPDATE`
 * matches no row — one email.
 *
 * `$3` (`redelivered`) bypasses the lease. A redelivery only happens because a
 * channel closed unacked — the consumer crashed — so no live process holds the
 * claim; waiting out the lease would make the redelivery skip and lose the
 * email. Fresh duplicates are unaffected because they are not redeliveries.
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

/**
 * Releasing the claim is load-bearing. Without this the one-second retry copy
 * meets a fresh sixty-second lease, the claim is refused, and the email is
 * silently dropped on the first SMTP blip (ADR-0003).
 */
export const MARK_PROCESSED_EVENT_FAILED_SQL = `
  UPDATE processed_event
     SET status = 'failed', last_error = $2
   WHERE event_id = $1
     AND status = 'processing'
`;
