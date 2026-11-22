export interface PaymentIntentStartResult {
  paymentIntentId: string;
  clientSecret: string;
  status: string;
}

export interface PaymentIntentSnapshot {
  id: string;
  clientSecret: string;
  status: string;
  amount: number;
  currency: string;
  amountReceived: number;
  metadata: Record<string, string>;
}
