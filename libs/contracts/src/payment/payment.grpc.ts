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
