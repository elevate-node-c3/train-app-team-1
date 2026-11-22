import type {
  CancelChargeRequest,
  CancelChargeResponse,
  GetHoldRequest,
  HoldSnapshot,
  QuoteBookingRequest,
  QuoteBookingResponse,
  RefundChargeRequest,
  RefundChargeResponse,
  SettleHoldRequest,
  SettlementSnapshot,
  StartChargeRequest,
  StartChargeResponse,
} from '@app/contracts';
import type { Observable } from 'rxjs';

/**
 * Catalog, payment, and inventory's settlement RPC are reached from here.
 * The hold's own lifecycle still goes through BookingDraftService, which owns
 * inventory's hold client, the booking key and the version fencing; the
 * confirmation saga only ever converts an existing hold into a sale.
 */
export const CATALOG_FLOW_CLIENT = Symbol('CATALOG_FLOW_CLIENT');
export const PAYMENT_FLOW_CLIENT = Symbol('PAYMENT_FLOW_CLIENT');
export const INVENTORY_FLOW_CLIENT = Symbol('INVENTORY_FLOW_CLIENT');

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
  refundCharge(
    request: RefundChargeRequest,
    metadata?: unknown,
    options?: { deadline: number },
  ): Observable<RefundChargeResponse>;
}

export interface InventoryFlowClient {
  releaseHold(
    request: GetHoldRequest,
    metadata?: unknown,
    options?: { deadline: number },
  ): Observable<HoldSnapshot>;
  settleHold(
    request: SettleHoldRequest,
    metadata?: unknown,
    options?: { deadline: number },
  ): Observable<SettlementSnapshot>;
}
