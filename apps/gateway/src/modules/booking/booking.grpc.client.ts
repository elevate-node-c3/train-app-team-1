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
  type BookingResponse,
  type ContinueBookingRequest,
  type SubmitBookingRequest,
} from '@app/contracts';

import {
  BOOKING_GRPC_CLIENT,
  type BookingGrpcClient,
} from './booking.types.js';

/**
 * Checkout holds seats and starts a charge, so it waits longer than a search
 * but still bounded: a stopped booking service must return a retryable error
 * rather than hang the request.
 */
export const BOOKING_REQUEST_TIMEOUT_MS = 6_000;

/** Give the gRPC deadline a moment to fire before rxjs gives up on it. */
const TIMEOUT_GRACE_MS = 250;

@Injectable()
export class BookingGrpcClientService {
  private readonly logger = new Logger(BookingGrpcClientService.name);

  constructor(
    @Inject(BOOKING_GRPC_CLIENT) private readonly client: BookingGrpcClient,
    private readonly cls: ClsService,
  ) {}

  submit(request: SubmitBookingRequest): Promise<BookingResponse> {
    return this.call((metadata, options) =>
      this.client.submitBooking(request, metadata, options),
    );
  }

  acceptTerms(request: ContinueBookingRequest): Promise<BookingResponse> {
    return this.call((metadata, options) =>
      this.client.acceptTerms(request, metadata, options),
    );
  }

  continueToPayment(request: ContinueBookingRequest): Promise<BookingResponse> {
    return this.call((metadata, options) =>
      this.client.continueToPayment(request, metadata, options),
    );
  }

  abandon(request: ContinueBookingRequest): Promise<BookingResponse> {
    return this.call((metadata, options) =>
      this.client.abandonBooking(request, metadata, options),
    );
  }

  get(request: ContinueBookingRequest): Promise<BookingResponse> {
    return this.call((metadata, options) =>
      this.client.getBooking(request, metadata, options),
    );
  }

  private async call(
    invoke: (
      metadata: Metadata,
      options: { deadline: number },
    ) => Observable<BookingResponse>,
  ): Promise<BookingResponse> {
    const deadline = Date.now() + BOOKING_REQUEST_TIMEOUT_MS;

    try {
      return await firstValueFrom(
        invoke(createGrpcMetadataWithCaller(this.cls), { deadline }).pipe(
          timeout(BOOKING_REQUEST_TIMEOUT_MS + TIMEOUT_GRACE_MS),
        ),
      );
    } catch (error: unknown) {
      throw this.httpErrorFor(error);
    }
  }

  /**
   * A refusal booking decided keeps its business code and field refs, which
   * HttpExceptionFilter resolves into the caller's language. Anything else is
   * only a transport status -- the details are never forwarded, because an
   * unrecognised payload may carry more than a caller should see.
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
        this.logger.warn(`booking call failed with gRPC status ${code}`);
      }
      return grpcStatusException(code);
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('booking call exceeded its deadline');
      return grpcStatusException(GRPC_STATUS.DEADLINE_EXCEEDED);
    }

    return error;
  }
}
