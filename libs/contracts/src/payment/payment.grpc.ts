import type { Metadata } from '@grpc/grpc-js';
import type { Observable } from 'rxjs';
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
  accountId: string;
  savedCardId?: string;
}

export interface StartChargeResponse {
  paymentReference: string;
  status: string;
  /** The Stripe client secret for the browser; never logged. Empty until created. */
  clientSecret?: string;
}

export interface CancelChargeRequest {
  bookingReference: string;
  paymentReference: string;
  idempotencyKey: string;
}

export interface CancelChargeResponse {
  status: string;
}

/**
 * The whole locked total, booking fee included; never a partial amount.
 * TA-110 owns the server side; until it lands payment marks the charge refunded
 * without calling Stripe. These shapes are the contract and do not change.
 */
export interface RefundChargeRequest {
  bookingReference: string;
  paymentReference: string;
  idempotencyKey: string;
}

/** status is REFUNDED, ALREADY_REFUNDED, or NOT_REFUNDABLE. */
export interface RefundChargeResponse {
  status: string;
  refundReference: string;
  amountPiastres: number;
}

export interface CreateSetupIntentRequest {
  accountId: string;
}

export interface CreateSetupIntentResponse {
  setupIntentId: string;
  clientSecret: string;
  publishableKey: string;
}

export interface ConfirmSetupRequest {
  accountId: string;
  setupIntentId: string;
}

export interface ListSavedCardsRequest {
  accountId: string;
}

export interface SavedCardItem {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  cardholderName: string;
  isDefault: boolean;
  canPay: boolean;
  isExpired: boolean;
  createdAt: string;
}

export interface ListSavedCardsResponse {
  cards: SavedCardItem[];
}

export interface SavedCardResponse {
  card: SavedCardItem;
}

export interface DeleteSavedCardRequest {
  accountId: string;
  cardId: string;
}

export interface DeleteSavedCardResponse {
  success: boolean;
}

export interface PaymentGrpcService {
  startCharge(
    request: StartChargeRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<StartChargeResponse>;
  cancelCharge(
    request: CancelChargeRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<CancelChargeResponse>;
  refundCharge(
    request: RefundChargeRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<RefundChargeResponse>;
  createSetupIntent(
    request: CreateSetupIntentRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<CreateSetupIntentResponse>;
  confirmSetup(
    request: ConfirmSetupRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<SavedCardResponse>;
  listSavedCards(
    request: ListSavedCardsRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<ListSavedCardsResponse>;
  deleteSavedCard(
    request: DeleteSavedCardRequest,
    metadata?: Metadata,
    options?: Record<string, unknown>,
  ): Observable<DeleteSavedCardResponse>;
}
