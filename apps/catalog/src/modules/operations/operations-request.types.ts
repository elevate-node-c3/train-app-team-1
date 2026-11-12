/** A row keyed by the client's `Idempotency-Key` (TA-20). */
export interface StoredOperationsRequest {
  idempotencyKey: string;
  fingerprint: string;
  responseJson: string;
}
