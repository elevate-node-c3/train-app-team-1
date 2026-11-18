import { getProtoPath } from '../proto-path.js';

export const PAYMENT_PACKAGE_NAME = 'train.payment.v1';
export const PAYMENT_SERVICE_NAME = 'PaymentService';

export function getPaymentProtoPath(): string {
  return getProtoPath('payment.proto');
}

export interface StartChargeRequest {
  bookingReference: string;
  amountPiastres: number;
  currency: string;
  idempotencyKey: string;
}

export interface StartChargeResponse {
  paymentReference: string;
  status: string;
}

export interface CancelChargeRequest {
  bookingReference: string;
  paymentReference: string;
  idempotencyKey: string;
}

export interface CancelChargeResponse {
  status: string;
}
