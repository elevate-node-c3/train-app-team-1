/** Stored response keyed by the client's Idempotency-Key. */
export interface StoredOperationsRequest {
  idempotencyKey: string;
  fingerprint: string;
  responseJson: string;
}
