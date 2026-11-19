import { Controller, UseInterceptors, UsePipes } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
} from '@app/common';
import { BOOKING_SERVICE_NAME, type BookingResponse } from '@app/contracts';

import {
  ContinueBookingRequestDto,
  SubmitBookingRequestDto,
} from './dto/booking-flow-request.dto.js';

import { BookingFlowService } from './services/booking-flow.service.js';
import { toRpcException } from './to-rpc-exception.js';

/** Transport only: every refusal becomes a status in one place. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UsePipes(createGrpcValidationPipe())
export class BookingFlowGrpcController {
  constructor(private readonly flow: BookingFlowService) {}

  @GrpcMethod(BOOKING_SERVICE_NAME, 'SubmitBooking')
  async submitBooking(
    request: SubmitBookingRequestDto,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.submit(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'AcceptTerms')
  async acceptTerms(
    request: ContinueBookingRequestDto,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.acceptTerms(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'ContinueToPayment')
  async continueToPayment(
    request: ContinueBookingRequestDto,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.continueToPayment(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'AbandonBooking')
  async abandonBooking(
    request: ContinueBookingRequestDto,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.abandon(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'GetBooking')
  async getBooking(
    request: ContinueBookingRequestDto,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.get(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
