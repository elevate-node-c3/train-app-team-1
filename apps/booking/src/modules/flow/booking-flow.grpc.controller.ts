import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { GrpcCorrelationInterceptor } from '@app/common';
import {
  BOOKING_SERVICE_NAME,
  type BookingResponse,
  type ContinueBookingRequest,
  type SubmitBookingRequest,
} from '@app/contracts';

import { BookingFlowService } from './booking-flow.service.js';
import { toRpcException } from './to-rpc-exception.js';

/** Transport only: every refusal becomes a status in one place. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class BookingFlowGrpcController {
  constructor(private readonly flow: BookingFlowService) {}

  @GrpcMethod(BOOKING_SERVICE_NAME, 'SubmitBooking')
  async submitBooking(
    request: SubmitBookingRequest,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.submit(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'AcceptTerms')
  async acceptTerms(
    request: ContinueBookingRequest,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.acceptTerms(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'ContinueToPayment')
  async continueToPayment(
    request: ContinueBookingRequest,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.continueToPayment(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'AbandonBooking')
  async abandonBooking(
    request: ContinueBookingRequest,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.abandon(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(BOOKING_SERVICE_NAME, 'GetBooking')
  async getBooking(
    request: ContinueBookingRequest,
  ): Promise<BookingResponse> {
    try {
      return await this.flow.get(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
