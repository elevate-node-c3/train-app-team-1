import { Controller, UseInterceptors, UsePipes } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
  toRpcException,
} from '@app/common';
import {
  TICKET_SERVICE_NAME,
  type SharedTicket,
  type TicketPage,
  type TicketPdf,
  type TicketQr,
  type TicketShareLink,
  type TicketVerification,
  type VerificationKeys,
} from '@app/contracts';

import {
  ListTicketsRequestDto,
  SharedTicketRequestDto,
  TicketPdfRequestDto,
  TicketRequestDto,
  VerifyTicketRequestDto,
} from './dto/ticket-request.dto.js';
import { TicketsService } from './services/tickets.service.js';

/** Transport only: every refusal becomes a status in one place. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UsePipes(createGrpcValidationPipe())
export class TicketsGrpcController {
  constructor(private readonly tickets: TicketsService) {}

  @GrpcMethod(TICKET_SERVICE_NAME, 'ListPaidTickets')
  listPaid(request: ListTicketsRequestDto): Promise<TicketPage> {
    return answer(() => this.tickets.listPaid(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'ListCancelledTickets')
  listCancelled(request: ListTicketsRequestDto): Promise<TicketPage> {
    return answer(() => this.tickets.listCancelled(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'GetTicketQr')
  qr(request: TicketRequestDto): Promise<TicketQr> {
    return answer(() => this.tickets.qr(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'CreateShareLink')
  shareLink(request: TicketRequestDto): Promise<TicketShareLink> {
    return answer(() => this.tickets.shareLink(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'GetTicketPdf')
  pdf(request: TicketPdfRequestDto): Promise<TicketPdf> {
    return answer(() => this.tickets.pdf(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'GetSharedTicket')
  shared(request: SharedTicketRequestDto): Promise<SharedTicket> {
    return answer(() => this.tickets.shared(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'VerifyTicket')
  verify(request: VerifyTicketRequestDto): Promise<TicketVerification> {
    return answer(() => this.tickets.verify(request));
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'GetVerificationKeys')
  verificationKeys(): Promise<VerificationKeys> {
    return answer(() => this.tickets.verificationKeys());
  }
}

async function answer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw toRpcException(error);
  }
}
