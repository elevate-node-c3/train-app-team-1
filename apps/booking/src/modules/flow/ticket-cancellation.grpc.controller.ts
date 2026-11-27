import { randomUUID } from 'node:crypto';
import { Controller, UseInterceptors, UsePipes } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import {
  CALLER_ACCOUNT_ID_KEY,
  CORRELATION_ID_KEY,
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
} from '@app/common';
import {
  ErrorCode,
  TICKET_SERVICE_NAME,
  type ConfirmTicketCancellationResponse,
  type PreviewTicketCancellationResponse,
} from '@app/contracts';

import { BookingFlowError } from './booking-flow-error.js';
import {
  ConfirmTicketCancellationRequestDto,
  PreviewTicketCancellationRequestDto,
} from './dto/ticket-cancellation-request.dto.js';
import { TicketCancellationService } from './services/ticket-cancellation.service.js';
import { toRpcException } from './to-rpc-exception.js';

/** Transport only: the caller and correlation come from gateway metadata. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UsePipes(createGrpcValidationPipe())
export class TicketCancellationGrpcController {
  constructor(
    private readonly cancellations: TicketCancellationService,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(TICKET_SERVICE_NAME, 'PreviewTicketCancellation')
  async preview(
    request: PreviewTicketCancellationRequestDto,
  ): Promise<PreviewTicketCancellationResponse> {
    try {
      return await this.cancellations.preview(request.ticketId, this.callerId());
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(TICKET_SERVICE_NAME, 'ConfirmTicketCancellation')
  async confirm(
    request: ConfirmTicketCancellationRequestDto,
  ): Promise<ConfirmTicketCancellationResponse> {
    try {
      return await this.cancellations.confirm(
        request,
        this.callerId(),
        this.correlationId(),
      );
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  private callerId(): string {
    const caller = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    if (!caller) throw new BookingFlowError(ErrorCode.UNAUTHORIZED);
    return caller;
  }

  private correlationId(): string {
    return this.cls.get<string>(CORRELATION_ID_KEY) ?? randomUUID();
  }
}
