/**
 * The delivery log is append-only: every attempt that reached the SMTP
 * crossing gets a row, because the BR-03 report counts what actually happened
 * over the wire rather than deduplicating it away (ADR-0003).
 *
 * The code is intentionally absent. There is no column it could go in.
 */
export const INSERT_EMAIL_DELIVERY_SQL = `
  INSERT INTO email_delivery (
    id, event_id, account_id, recipient_email, purpose, outcome,
    skip_reason, issued_at, accepted_at, latency_ms, error_message
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;
