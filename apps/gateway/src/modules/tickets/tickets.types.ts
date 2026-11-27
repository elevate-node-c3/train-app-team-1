import type { CallOptions } from '@grpc/grpc-js';
import type { Observable } from 'rxjs';
import type {
  ConfirmTicketCancellationRequest,
  ConfirmTicketCancellationResponse,
  ListTicketsRequest,
  PreviewTicketCancellationRequest,
  PreviewTicketCancellationResponse,
  SharedTicket,
  SharedTicketRequest,
  TicketPage,
  TicketPdf,
  TicketPdfRequest,
  TicketQr,
  TicketRequest,
  TicketShareLink,
  TicketVerification,
  VerificationKeys,
  VerifyTicketRequest,
} from '@app/contracts';

export const TICKETS_GRPC_CLIENT = 'TICKETS_GRPC_CLIENT';

/** Proxy methods include metadata and options so every call carries a deadline. */
export interface TicketsGrpcClient {
  listPaidTickets(
    data: ListTicketsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TicketPage>;

  listCancelledTickets(
    data: ListTicketsRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TicketPage>;

  getTicketQr(
    data: TicketRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TicketQr>;

  createShareLink(
    data: TicketRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TicketShareLink>;

  getTicketPdf(
    data: TicketPdfRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TicketPdf>;

  getSharedTicket(
    data: SharedTicketRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<SharedTicket>;

  verifyTicket(
    data: VerifyTicketRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<TicketVerification>;

  getVerificationKeys(
    data: Record<string, never>,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<VerificationKeys>;

  previewTicketCancellation(
    data: PreviewTicketCancellationRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<PreviewTicketCancellationResponse>;

  confirmTicketCancellation(
    data: ConfirmTicketCancellationRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ConfirmTicketCancellationResponse>;
}
