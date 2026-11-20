import type { CallOptions } from '@grpc/grpc-js';
import type {
  BookingResponse,
  ContinueBookingRequest,
  SubmitBookingRequest,
} from '@app/contracts';
import type { Observable } from 'rxjs';

export const BOOKING_GRPC_CLIENT = 'BOOKING_GRPC_CLIENT';

/** Proxy methods include metadata and options so every call carries a deadline. */
export interface BookingGrpcClient {
  submitBooking(
    data: SubmitBookingRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<BookingResponse>;

  acceptTerms(
    data: ContinueBookingRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<BookingResponse>;

  continueToPayment(
    data: ContinueBookingRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<BookingResponse>;

  abandonBooking(
    data: ContinueBookingRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<BookingResponse>;

  getBooking(
    data: ContinueBookingRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<BookingResponse>;
}
