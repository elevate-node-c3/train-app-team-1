import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BookingRequestGuard } from './booking-request.guard.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const valid = {
  bookingKey: uuid,
  passengerIds: [uuid],
  legs: [
    {
      tripId: uuid,
      travelClassId: uuid,
      originStationId: uuid,
      destinationStationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
  ],
};
const context = (body: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ body, headers: {} }) }),
  }) as ExecutionContext;

describe('Gateway hold payload privacy before validation pipes', () => {
  it('accepts only identifiers used by the private Booking request', () => {
    expect(new BookingRequestGuard().canActivate(context(valid))).toBe(true);
  });
  it.each([
    { ...valid, nationalId: '29801011234567' },
    { ...valid, passengers: [{ nationalId: '29801011234567' }] },
    { ...valid, passengerIds: ['29801011234567'] },
    { ...valid, legs: [{ ...valid.legs[0], tripId: '29801011234567' }] },
    { ...valid, legs: [{ ...valid.legs[0], passengerToken: 'private-token' }] },
    { ...valid, bookingKey: '29801011234567' },
  ])(
    'refuses inline identities without reflecting sensitive rejected values',
    (body) => {
      try {
        new BookingRequestGuard().canActivate(context(body));
        throw new Error('expected refusal');
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          response: { code: 'INVALID_PAYLOAD' },
        });
        expect(JSON.stringify(error)).not.toContain('29801011234567');
        expect(JSON.stringify(error)).not.toContain('private-token');
      }
    },
  );
});
