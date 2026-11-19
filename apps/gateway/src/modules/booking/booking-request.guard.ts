import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ErrorCode } from '@app/contracts';

@Injectable()
export class BookingRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ body: unknown; headers: Record<string, unknown> }>();
    const refuse = (): never => {
      throw new HttpException(
        { code: ErrorCode.INVALID_PAYLOAD },
        HttpStatus.BAD_REQUEST,
      );
    };
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) refuse();
    const input = body as Record<string, unknown>;
    const allowed = new Set([
      'bookingKey',
      'passengerIds',
      'legs',
      'tripId',
      'travelClassId',
      'originStationId',
      'destinationStationId',
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key))) refuse();
    const key = request.headers['idempotency-key'] ?? input.bookingKey;
    if (
      !isUUID(key) ||
      (input.bookingKey !== undefined &&
        (!isUUID(input.bookingKey) || input.bookingKey !== key))
    )
      refuse();
    const passengers = input.passengerIds;
    if (
      !Array.isArray(passengers) ||
      passengers.length < 1 ||
      passengers.length > 4 ||
      !passengers.every((ref) => isUUID(ref)) ||
      new Set(passengers.map((id: string) => id.toLowerCase())).size !==
        passengers.length
    )
      refuse();

    const legKeys = [
      'tripId',
      'travelClassId',
      'originStationId',
      'destinationStationId',
    ];
    if (
      input.legs !== undefined &&
      legKeys.some((field) => input[field] !== undefined)
    )
      refuse();
    const legs = input.legs ?? [
      {
        tripId: input.tripId,
        travelClassId: input.travelClassId,
        originStationId: input.originStationId,
        destinationStationId: input.destinationStationId,
      },
    ];
    if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2) refuse();
    const trips = new Set<string>();
    for (const candidate of legs as unknown[]) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      )
        refuse();
      const leg = candidate as Record<string, unknown>;
      if (
        Object.keys(leg).some((field) => !legKeys.includes(field)) ||
        !legKeys.every((field) => isUUID(leg[field]))
      )
        refuse();
      const trip = (leg.tripId as string).toLowerCase();
      if (
        trips.has(trip) ||
        (leg.originStationId as string).toLowerCase() ===
          (leg.destinationStationId as string).toLowerCase()
      )
        refuse();
      trips.add(trip);
    }
    // Guards run before ValidationPipe, whose rejectedValue must never echo an ID.
    return true;
  }
}
