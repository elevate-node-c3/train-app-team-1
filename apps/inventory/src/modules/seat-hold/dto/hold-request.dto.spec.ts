import { describe, expect, it } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { createGrpcValidationPipe, decodeRefusal } from '@app/common';
import { resolveDetailText } from '@app/common/envelope/detail-messages.js';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

import { CreateHoldRequestDto, GetHoldRequestDto } from './hold-request.dto.js';

const pipe = createGrpcValidationPipe();

const OWNER_ID = '70000000-0000-4000-8000-000000000001';
const TRIP_ID = '10000000-0000-4000-8000-000000000001';
const RETURN_TRIP_ID = '10000000-0000-4000-8000-000000000002';
const CLASS_ID = '20000000-0000-4000-8000-000000000001';
const ORIGIN_ID = '30000000-0000-4000-8000-000000000001';
const DESTINATION_ID = '30000000-0000-4000-8000-000000000002';

function leg(tripId = TRIP_ID) {
  return {
    tripId,
    travelClassId: CLASS_ID,
    originStationId: ORIGIN_ID,
    destinationStationId: DESTINATION_ID,
  };
}

function passenger(passengerRef: string, tripIds: string[] = [TRIP_ID]) {
  return {
    passengerRef,
    identities: tripIds.map((tripId) => ({
      tripId,
      passengerToken: 'a'.repeat(64),
      passengerKeyVersion: 1,
    })),
  };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER_ID,
    bookingKey: 'booking-key-1',
    legs: [leg()],
    passengers: [passenger('p-1')],
    ...overrides,
  };
}

async function refuse(
  value: unknown,
  metatype: unknown = CreateHoldRequestDto,
): Promise<{ status: number; details: ValidationIssueRef[] }> {
  try {
    await pipe.transform(value, {
      type: 'body',
      metatype: metatype as never,
    });
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RpcException);
    const payload = (error as RpcException).getError() as { code: number };
    const refusal = decodeRefusal(error);
    expect(refusal?.code).toBe(ErrorCode.VALIDATION_ERROR);
    return { status: payload.code, details: refusal?.details ?? [] };
  }

  throw new Error('Expected the request to be refused.');
}

function issueKeys(details: ValidationIssueRef[]): string[] {
  return details.map((detail) => detail.issueKey);
}

function fieldsOf(details: ValidationIssueRef[]): string[] {
  return details.map((detail) => detail.field);
}

describe('hold request DTOs', () => {
  describe('what the service already accepts', () => {
    it('accepts a well-formed hold and returns the DTO class', async () => {
      const value = await pipe.transform(createRequest(), {
        type: 'body',
        metatype: CreateHoldRequestDto as never,
      });

      expect(value).toBeInstanceOf(CreateHoldRequestDto);
      expect(value.legs[0]).toMatchObject(leg());
      expect(value.passengers[0].identities[0].passengerKeyVersion).toBe(1);
    });

    it('refuses an id that is not an RFC UUID', async () => {
      const { details } = await refuse(
        createRequest({ ownerId: '70000000-0000-0000-0000-000000000001' }),
      );

      expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_UUID']);
    });

    it('leaves bookingKey and passengerRef opaque', async () => {
      const value = await pipe.transform(
        createRequest({
          bookingKey: 'not-a-uuid/at+all',
          passengers: [passenger('ref:1')],
        }),
        { type: 'body', metatype: CreateHoldRequestDto as never },
      );

      expect(value.bookingKey).toBe('not-a-uuid/at+all');
      expect(value.passengers[0].passengerRef).toBe('ref:1');
    });

    it('accepts a round trip with one identity per leg', async () => {
      const value = await pipe.transform(
        createRequest({
          legs: [leg(), leg(RETURN_TRIP_ID)],
          passengers: [passenger('p-1', [TRIP_ID, RETURN_TRIP_ID])],
        }),
        { type: 'body', metatype: CreateHoldRequestDto as never },
      );

      expect(value.passengers[0].identities).toHaveLength(2);
    });
  });

  describe('what it refuses, and how', () => {
    it('refuses with INVALID_ARGUMENT and names the field', async () => {
      const { status, details } = await refuse(
        createRequest({ ownerId: 'not-an-id' }),
      );

      expect(status).toBe(grpc.status.INVALID_ARGUMENT);
      expect(details).toEqual([
        {
          field: 'ownerId',
          rejectedValue: 'not-an-id',
          issueKey: 'ISSUE_MUST_BE_UUID',
        },
      ]);
    });

    it('refuses a missing bookingKey as required', async () => {
      const { details } = await refuse(
        createRequest({ bookingKey: '' }),
        GetHoldRequestDto,
      );

      expect(issueKeys(details)).toContain('ISSUE_REQUIRED');
    });

    it('refuses more passengers than a booking may hold', async () => {
      const { details } = await refuse(
        createRequest({
          passengers: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((ref) =>
            passenger(ref),
          ),
        }),
      );

      expect(fieldsOf(details)).toEqual(['passengers']);
      expect(issueKeys(details)).toEqual(['ISSUE_LIST_TOO_LONG']);
    });

    it('refuses an empty leg list', async () => {
      const { details } = await refuse(createRequest({ legs: [] }));

      expect(issueKeys(details)).toContain('ISSUE_LIST_TOO_SHORT');
    });

    it('refuses the same trip twice, and the same passenger twice', async () => {
      const legs = await refuse(createRequest({ legs: [leg(), leg()] }));
      const passengers = await refuse(
        createRequest({ passengers: [passenger('p-1'), passenger('p-1')] }),
      );

      expect(legs.details).toEqual([
        {
          field: 'legs',
          rejectedValue: [leg(), leg()],
          issueKey: 'ISSUE_LIST_HAS_DUPLICATES',
        },
      ]);
      expect(issueKeys(passengers.details)).toEqual([
        'ISSUE_LIST_HAS_DUPLICATES',
      ]);
    });

    it('refuses a field the proto does not define', async () => {
      const { details } = await refuse(createRequest({ seatNumbers: ['12A'] }));

      // BR: a traveller never picks a seat, so the field must not be honoured.
      expect(details).toEqual([
        {
          field: 'seatNumbers',
          rejectedValue: ['12A'],
          issueKey: 'ISSUE_UNKNOWN_FIELD',
        },
      ]);
    });

    it('names the nested identity that is wrong', async () => {
      const { details } = await refuse(
        createRequest({
          passengers: [
            {
              passengerRef: 'p-1',
              identities: [
                { tripId: 'nope', passengerToken: 'x', passengerKeyVersion: 0 },
              ],
            },
          ],
        }),
      );

      expect(fieldsOf(details)).toEqual(
        expect.arrayContaining([
          'passengers.0.identities.0.tripId',
          'passengers.0.identities.0.passengerKeyVersion',
        ]),
      );
      expect(issueKeys(details)).toContain('ISSUE_MUST_BE_UUID');
      expect(issueKeys(details)).toContain('ISSUE_BELOW_MINIMUM');
    });
  });

  describe('a refusal a caller can read', () => {
    it('never echoes an identity token back', async () => {
      const token = 'secret-hmac-value';
      const { details } = await refuse(
        createRequest({
          passengers: [
            {
              passengerRef: 'p-1',
              identities: [
                { tripId: TRIP_ID, passengerToken: '', passengerKeyVersion: 1 },
              ],
            },
          ],
        }),
      );

      const tokenDetail = details.find((detail) =>
        detail.field.endsWith('passengerToken'),
      );
      expect(tokenDetail?.issueKey).toBe('ISSUE_REQUIRED');
      expect(tokenDetail?.rejectedValue).toBeUndefined();
      expect(JSON.stringify(details)).not.toContain(token);
    });

    it('resolves every key it emits into Arabic and English', async () => {
      const { details } = await refuse(
        createRequest({ ownerId: 'not-an-id', legs: [] }),
      );

      expect(details.length).toBeGreaterThan(1);
      for (const detail of details) {
        const ar = resolveDetailText(detail.issueKey, 'ar');
        const en = resolveDetailText(detail.issueKey, 'en');

        expect(ar).not.toBe('');
        expect(en).not.toBe('');
        expect(ar).not.toBe(en);
        expect(ar).not.toContain('{{');
        expect(en).not.toContain('{{');
      }
    });
  });
});
