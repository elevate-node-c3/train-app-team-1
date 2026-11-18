import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { ErrorCode } from '@app/contracts';
import { matchesServiceCredential } from '@app/common/grpc/service-credential.js';
import { normalizeBookingIntent } from './booking-draft.service.js';

/** Authenticate the service hop, not BR-10; bookable access belongs to Gateway. */
@Injectable()
export class BookingIngressGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (
      !matchesServiceCredential(
        request.headers['x-gateway-booking-key'],
        process.env.GATEWAY_BOOKING_SERVICE_KEY,
      )
    )
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED });
    // Shared validation details echo rejected values. Reject untrusted shapes
    // before that pipe can reflect inline National IDs or comparison tokens.
    if (request.method === 'POST') {
      try {
        normalizeBookingIntent(request.body);
      } catch {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_ERROR });
      }
    }
    return true;
  }
}
