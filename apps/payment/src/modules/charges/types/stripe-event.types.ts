/** `ignored` is an event for another concern; `duplicate` is one already recorded. */
export type ChargeWebhookResult = 'recorded' | 'duplicate' | 'ignored';

export interface StripeEventRecord {
  id: string;
  type: string;
  objectId: string;
  payload: unknown;
}

export interface ChargeIntentPayload {
  id?: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  metadata?: { bookingReference?: string; paymentReference?: string };
}
