import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { CORRELATION_ID_KEY, CORRELATION_ID_HEADER } from '@app/common';
import { Metadata as GrpcMetadata } from '@grpc/grpc-js';
import type {
  CancelChargeRequest,
  CancelChargeResponse,
  QuoteBookingRequest,
  QuoteBookingResponse,
  RefundChargeRequest,
  RefundChargeResponse,
  SettleHoldRequest,
  SettlementSnapshot,
  StartChargeRequest,
  StartChargeResponse,
} from '@app/contracts';
import {
  CATALOG_FLOW_CLIENT,
  INVENTORY_FLOW_CLIENT,
  PAYMENT_FLOW_CLIENT,
  type CatalogFlowClient,
  type InventoryFlowClient,
  type PaymentFlowClient,
} from '../flow-clients.types.js';

export const FLOW_GRPC_DEADLINE_MS = 1_800;

@Injectable()
export class FlowGrpcClientsService {
  constructor(
    @Inject(CATALOG_FLOW_CLIENT) private readonly catalog: CatalogFlowClient,
    @Inject(PAYMENT_FLOW_CLIENT) private readonly payment: PaymentFlowClient,
    @Inject(INVENTORY_FLOW_CLIENT)
    private readonly inventory: InventoryFlowClient,
    private readonly cls: ClsService,
  ) {}

  quote(
    request: QuoteBookingRequest,
    correlationId?: string,
  ): Promise<QuoteBookingResponse> {
    return this.call(
      (metadata, deadline) =>
        this.catalog.quoteBooking(request, metadata, { deadline }),
      correlationId,
    );
  }

  startCharge(
    request: StartChargeRequest,
    correlationId?: string,
  ): Promise<StartChargeResponse> {
    return this.call(
      (metadata, deadline) =>
        this.payment.startCharge(request, metadata, { deadline }),
      correlationId,
    );
  }

  cancelCharge(
    request: CancelChargeRequest,
    correlationId?: string,
  ): Promise<CancelChargeResponse> {
    return this.call(
      (metadata, deadline) =>
        this.payment.cancelCharge(request, metadata, { deadline }),
      correlationId,
    );
  }

  refundCharge(
    request: RefundChargeRequest,
    correlationId?: string,
  ): Promise<RefundChargeResponse> {
    return this.call(
      (metadata, deadline) =>
        this.payment.refundCharge(request, metadata, { deadline }),
      correlationId,
    );
  }

  settleHold(
    request: SettleHoldRequest,
    correlationId?: string,
  ): Promise<SettlementSnapshot> {
    return this.call(
      (metadata, deadline) =>
        this.inventory.settleHold(request, metadata, { deadline }),
      correlationId,
    );
  }

  private call<T>(
    invoke: (metadata: Metadata, deadline: number) => Observable<T>,
    callerCorrelationId?: string,
  ): Promise<T> {
    const metadata = new GrpcMetadata();
    const correlationId =
      callerCorrelationId ?? this.cls.get<string>(CORRELATION_ID_KEY);
    if (correlationId) metadata.set(CORRELATION_ID_HEADER, correlationId);
    const deadline = Date.now() + FLOW_GRPC_DEADLINE_MS;
    return firstValueFrom(
      invoke(metadata, deadline).pipe(timeout(FLOW_GRPC_DEADLINE_MS + 100)),
    );
  }
}
