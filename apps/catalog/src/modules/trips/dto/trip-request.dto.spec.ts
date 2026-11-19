import { describe, expect, it } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import { createGrpcValidationPipe, decodeRefusal } from '@app/common';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

import {
  GetTripStopsRequestDto,
  QuoteBookingRequestDto,
} from './trip-request.dto.js';

const pipe = createGrpcValidationPipe();
const TRIP_ID = '10000000-0000-4000-8000-000000000001';
const CLASS_ID = '50000000-0000-4000-8000-000000000001';
const ORIGIN_ID = '20000000-0000-4000-8000-000000000001';
const DESTINATION_ID = '20000000-0000-4000-8000-000000000002';

function leg() {
  return {
    tripId: TRIP_ID,
    originStationId: ORIGIN_ID,
    destinationStationId: DESTINATION_ID,
  };
}

async function accept<T>(value: unknown, metatype: unknown): Promise<T> {
  return (await pipe.transform(value, {
    type: 'body',
    metatype: metatype as never,
  })) as T;
}

async function refuse(
  value: unknown,
  metatype: unknown,
): Promise<ValidationIssueRef[]> {
  try {
    await pipe.transform(value, { type: 'body', metatype: metatype as never });
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RpcException);
    const refusal = decodeRefusal(error);
    expect(refusal?.code).toBe(ErrorCode.VALIDATION_ERROR);
    return refusal?.details ?? [];
  }

  throw new Error('Expected the request to be refused.');
}

function issueKeys(details: ValidationIssueRef[]): string[] {
  return details.map((detail) => detail.issueKey);
}

describe('trip request DTOs', () => {
  describe('GetTripStops', () => {
    it('accepts a journey, with or without a language', async () => {
      await expect(
        accept({ ...leg(), language: 'ar' }, GetTripStopsRequestDto),
      ).resolves.toBeInstanceOf(GetTripStopsRequestDto);
      // proto3 sends '' for an omitted string, which the contract allows.
      await expect(
        accept({ ...leg(), language: '' }, GetTripStopsRequestDto),
      ).resolves.toBeInstanceOf(GetTripStopsRequestDto);
      await expect(
        accept(leg(), GetTripStopsRequestDto),
      ).resolves.toBeInstanceOf(GetTripStopsRequestDto);
    });

    it('refuses a trip id a uuid column could not store', async () => {
      // This used to reach the query and come back as a masked INTERNAL.
      const details = await refuse(
        { ...leg(), tripId: 'trip-1' },
        GetTripStopsRequestDto,
      );

      expect(details).toEqual([
        {
          field: 'tripId',
          rejectedValue: 'trip-1',
          issueKey: 'ISSUE_MUST_BE_UUID',
        },
      ]);
    });

    it('refuses a language outside the contract', async () => {
      const details = await refuse(
        { ...leg(), language: 'fr' },
        GetTripStopsRequestDto,
      );

      expect(issueKeys(details)).toEqual(['ISSUE_NOT_AN_ALLOWED_VALUE']);
    });
  });

  describe('QuoteBooking', () => {
    it('accepts an outbound leg and a return', async () => {
      const value = await accept<QuoteBookingRequestDto>(
        { legs: [leg(), leg()], travelClassId: CLASS_ID },
        QuoteBookingRequestDto,
      );

      expect(value.legs).toHaveLength(2);
    });

    it('refuses more legs than a round trip has', async () => {
      const details = await refuse(
        { legs: [leg(), leg(), leg()], travelClassId: CLASS_ID },
        QuoteBookingRequestDto,
      );

      expect(issueKeys(details)).toEqual(['ISSUE_LIST_TOO_LONG']);
    });

    it('refuses a quote with no leg to price', async () => {
      const details = await refuse(
        { legs: [], travelClassId: CLASS_ID },
        QuoteBookingRequestDto,
      );

      expect(issueKeys(details)).toEqual(['ISSUE_LIST_TOO_SHORT']);
    });

    it('names the leg whose station is malformed', async () => {
      const details = await refuse(
        {
          legs: [leg(), { ...leg(), destinationStationId: 'nope' }],
          travelClassId: CLASS_ID,
        },
        QuoteBookingRequestDto,
      );

      expect(details.map((detail) => detail.field)).toContain(
        'legs.1.destinationStationId',
      );
      expect(issueKeys(details)).toContain('ISSUE_MUST_BE_UUID');
    });

    it('refuses a field catalog.proto does not define', async () => {
      const details = await refuse(
        { legs: [leg()], travelClassId: CLASS_ID, seatNumbers: ['3B'] },
        QuoteBookingRequestDto,
      );

      expect(details).toEqual([
        {
          field: 'seatNumbers',
          rejectedValue: ['3B'],
          issueKey: 'ISSUE_UNKNOWN_FIELD',
        },
      ]);
    });
  });
});
