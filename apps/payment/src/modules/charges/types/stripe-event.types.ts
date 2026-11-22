export type ChargeWebhookResult = 'recorded' | 'duplicate';

export interface StripeEventRecord {
  id: string;
  type: string;
  objectId: string;
  payload: unknown;
}

export interface ChargeIntentPayload {
  amount?: number;
  currency?: string;
}
