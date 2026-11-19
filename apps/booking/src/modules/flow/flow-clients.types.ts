import type {
  CancelChargeRequest,
  CancelChargeResponse,
  QuoteBookingRequest,
  QuoteBookingResponse,
  StartChargeRequest,
  StartChargeResponse,
} from '@app/contracts';
import type { Observable } from 'rxjs';

/**
 * Only catalog and payment are reached from here. Holds go through
 * BookingDraftService, which owns inventory's client, the booking key and the
 * version fencing; the passengers it resolved are already on the draft.
 */
export const CATALOG_FLOW_CLIENT = Symbol('CATALOG_FLOW_CLIENT');
export const PAYMENT_FLOW_CLIENT = Symbol('PAYMENT_FLOW_CLIENT');

export interface CatalogFlowClient {
  quoteBooking(
    request: QuoteBookingRequest,
    metadata?: unknown,
    options?: { deadline: number },
  ): Observable<QuoteBookingResponse>;
}

export interface PaymentFlowClient {
  startCharge(
    request: StartChargeRequest,
    metadata?: unknown,
    options?: { deadline: number },
  ): Observable<StartChargeResponse>;
  cancelCharge(
    request: CancelChargeRequest,
    metadata?: unknown,
    options?: { deadline: number },
  ): Observable<CancelChargeResponse>;
}
