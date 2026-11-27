import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import {
  createGrpcMetadataWithCaller,
  decodeRefusal,
  grpcStatusException,
  refusalHttpException,
} from '@app/common';
import {
  GRPC_STATUS,
  type ConfirmTicketCancellationRequest,
  type ConfirmTicketCancellationResponse,
  type ListTicketsRequest,
  type PreviewTicketCancellationResponse,
  type SharedTicket,
  type TicketPage,
  type TicketPdf,
  type TicketPdfRequest,
  type TicketQr,
  type TicketShareLink,
  type TicketVerification,
  type VerificationKeys,
} from '@app/contracts';

import {
  TICKETS_GRPC_CLIENT,
  type TicketsGrpcClient,
} from './tickets.types.js';

/** A PDF is rendered on the call, so it gets checkout's bound, not search's. */
export const TICKETS_REQUEST_TIMEOUT_MS = 6_000;

/** Give the gRPC deadline a moment to fire before rxjs gives up on it. */
const TIMEOUT_GRACE_MS = 250;

/**
 * Booking's TicketService, reached with the caller the gateway verified. The
 * owner is never read from the request: booking takes it from this metadata.
 */
@Injectable()
export class TicketsGrpcClientService {
  private readonly logger = new Logger(TicketsGrpcClientService.name);

  constructor(
    @Inject(TICKETS_GRPC_CLIENT) private readonly client: TicketsGrpcClient,
    private readonly cls: ClsService,
  ) {}

  listPaid(request: ListTicketsRequest): Promise<TicketPage> {
    return this.call((metadata, options) =>
      this.client.listPaidTickets(request, metadata, options),
    );
  }

  listCancelled(request: ListTicketsRequest): Promise<TicketPage> {
    return this.call((metadata, options) =>
      this.client.listCancelledTickets(request, metadata, options),
    );
  }

  qr(ticketId: string): Promise<TicketQr> {
    return this.call((metadata, options) =>
      this.client.getTicketQr({ ticketId }, metadata, options),
    );
  }

  shareLink(ticketId: string): Promise<TicketShareLink> {
    return this.call((metadata, options) =>
      this.client.createShareLink({ ticketId }, metadata, options),
    );
  }

  pdf(request: TicketPdfRequest): Promise<TicketPdf> {
    return this.call((metadata, options) =>
      this.client.getTicketPdf(request, metadata, options),
    );
  }

  shared(token: string): Promise<SharedTicket> {
    return this.call((metadata, options) =>
      this.client.getSharedTicket({ token }, metadata, options),
    );
  }

  verify(qr: string): Promise<TicketVerification> {
    return this.call((metadata, options) =>
      this.client.verifyTicket({ qr }, metadata, options),
    );
  }

  verificationKeys(): Promise<VerificationKeys> {
    return this.call((metadata, options) =>
      this.client.getVerificationKeys({}, metadata, options),
    );
  }

  previewCancellation(
    ticketId: string,
  ): Promise<PreviewTicketCancellationResponse> {
    return this.call((metadata, options) =>
      this.client.previewTicketCancellation({ ticketId }, metadata, options),
    );
  }

  confirmCancellation(
    request: ConfirmTicketCancellationRequest,
  ): Promise<ConfirmTicketCancellationResponse> {
    return this.call((metadata, options) =>
      this.client.confirmTicketCancellation(request, metadata, options),
    );
  }

  private async call<T>(
    invoke: (
      metadata: Metadata,
      options: { deadline: number },
    ) => Observable<T>,
  ): Promise<T> {
    const deadline = Date.now() + TICKETS_REQUEST_TIMEOUT_MS;
    try {
      return await firstValueFrom(
        invoke(createGrpcMetadataWithCaller(this.cls), { deadline }).pipe(
          timeout(TICKETS_REQUEST_TIMEOUT_MS + TIMEOUT_GRACE_MS),
        ),
      );
    } catch (error: unknown) {
      throw this.httpErrorFor(error);
    }
  }

  /**
   * A refusal booking decided keeps its business code, which the exception
   * filter resolves into the caller's language; anything else is only a
   * transport status, with no details forwarded.
   */
  private httpErrorFor(error: unknown): unknown {
    const refusal = decodeRefusal((error as { details?: unknown })?.details);
    if (refusal) return refusalHttpException(refusal);

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      if (
        code === GRPC_STATUS.UNAVAILABLE ||
        code === GRPC_STATUS.DEADLINE_EXCEEDED
      ) {
        this.logger.warn(`ticket call failed with gRPC status ${code}`);
      }
      return grpcStatusException(code);
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('ticket call exceeded its deadline');
      return grpcStatusException(GRPC_STATUS.DEADLINE_EXCEEDED);
    }

    return error;
  }
}
