import { describe, expect, it } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import { createGrpcValidationPipe, decodeRefusal } from '@app/common';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

import {
  AddPassengerRequestBodyDto,
  CompleteProfileRequestBodyDto,
  DeletePassengerRequestBodyDto,
  ResolveHoldPassengersRequestBodyDto,
  ResolveNotificationRecipientRequestBodyDto,
  SignInRequestBodyDto,
  SignOutRequestBodyDto,
  SignUpRequestBodyDto,
} from './identity-request.dto.js';

const pipe = createGrpcValidationPipe();
const ACCOUNT_ID = '60000000-0000-4000-8000-000000000001';
const PASSENGER_ID = '61000000-0000-4000-8000-000000000001';
const TRIP_ID = '10000000-0000-4000-8000-000000000001';

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

describe('identity request DTOs', () => {
  it('accepts only a valid UUID for the private notification directory lookup', async () => {
    const value = await accept<ResolveNotificationRecipientRequestBodyDto>(
      { accountId: ACCOUNT_ID },
      ResolveNotificationRecipientRequestBodyDto,
    );
    expect(value.accountId).toBe(ACCOUNT_ID);
    const details = await refuse(
      { accountId: 'invalid-account-id' },
      ResolveNotificationRecipientRequestBodyDto,
    );
    expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_UUID']);
  });

  describe('what the validators keep', () => {
    it('lets a bad National ID through to the validator that names it', async () => {
      // profile-validation.ts answers INVALID_NATIONAL_ID_CENTURY and friends;
      // refusing here would flatten five codes into VALIDATION_ERROR.
      const value = await accept<CompleteProfileRequestBodyDto>(
        {
          fullName: 'Single',
          phoneNumber: '123',
          nationalId: '999',
          profileType: 'Nonsense',
          nationality: 'Nowhere',
        },
        CompleteProfileRequestBodyDto,
      );

      expect(value.nationalId).toBe('999');
      expect(value.fullName).toBe('Single');
      expect(value.phoneNumber).toBe('123');
    });

    it('lets an empty password through, so sign-in answers INVALID_CREDENTIALS', async () => {
      const value = await accept<SignInRequestBodyDto>(
        { email: 'user@example.com', password: '', deviceId: '' },
        SignInRequestBodyDto,
      );

      expect(value.password).toBe('');
    });

    it('keeps a field the pipe would otherwise strip', async () => {
      // whitelist drops any property without a decorator, so a validator-owned
      // field still needs one to survive.
      const value = await accept<AddPassengerRequestBodyDto>(
        {
          accountId: ACCOUNT_ID,
          fullName: 'Ahmed Hussein',
          nationalId: '28505150101235',
          profileType: 'Regular',
          language: 'ar',
        },
        AddPassengerRequestBodyDto,
      );

      expect(value).toMatchObject({
        fullName: 'Ahmed Hussein',
        nationalId: '28505150101235',
        profileType: 'Regular',
        language: 'ar',
      });
    });
  });

  describe('what the DTO answers', () => {
    it('refuses an account id a uuid column could not store', async () => {
      const details = await refuse(
        { passengerId: PASSENGER_ID, accountId: 'acc-123' },
        DeletePassengerRequestBodyDto,
      );

      expect(details).toEqual([
        {
          field: 'accountId',
          rejectedValue: 'acc-123',
          issueKey: 'ISSUE_MUST_BE_UUID',
        },
      ]);
    });

    it('refuses an address that is not an email', async () => {
      const details = await refuse(
        { email: 'not-an-email', password: 'Str0ng!Pass' },
        SignUpRequestBodyDto,
      );

      expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_EMAIL']);
    });

    it('refuses a language outside the proto domain', async () => {
      const details = await refuse(
        { email: 'user@example.com', password: 'x', language: 'fr' },
        SignUpRequestBodyDto,
      );

      expect(issueKeys(details)).toEqual(['ISSUE_NOT_AN_ALLOWED_VALUE']);
    });

    it("accepts '' as no language preference", async () => {
      const value = await accept<SignUpRequestBodyDto>(
        { email: 'user@example.com', password: 'x', language: '' },
        SignUpRequestBodyDto,
      );

      expect(value.language).toBe('');
    });

    it('refuses an expiry that is not a date', async () => {
      const details = await refuse(
        {
          refreshToken: 'token',
          sessionId: 'session-from-token',
          jti: 'jti-1',
          accessTokenExpiresAt: 'whenever',
        },
        SignOutRequestBodyDto,
      );

      expect(issueKeys(details)).toEqual(['ISSUE_ISO_DATE_TIME_FORMAT']);
    });

    it('accepts the session and jti as claims, which are not UUIDs', async () => {
      const value = await accept<SignOutRequestBodyDto>(
        {
          refreshToken: 'token',
          sessionId: 'session-from-token',
          jti: 'jti-1',
          accessTokenExpiresAt: new Date().toISOString(),
        },
        SignOutRequestBodyDto,
      );

      expect(value.sessionId).toBe('session-from-token');
    });

    it("names the passenger ref booking's private call got wrong", async () => {
      const details = await refuse(
        {
          ownerId: ACCOUNT_ID,
          passengerRefs: [PASSENGER_ID, 'nope'],
          tripIds: [TRIP_ID],
        },
        ResolveHoldPassengersRequestBodyDto,
      );

      expect(details[0].field).toBe('passengerRefs');
      expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_UUID']);
    });

    it('never echoes a secret back on a refusal', async () => {
      const details = await refuse(
        {
          refreshToken: '',
          sessionId: 'session-1',
          jti: 'jti-1',
          accessTokenExpiresAt: new Date().toISOString(),
        },
        SignOutRequestBodyDto,
      );

      expect(details[0].field).toBe('refreshToken');
      expect(details[0].rejectedValue).toBeUndefined();
    });

    it('refuses a field identity.proto does not define', async () => {
      const details = await refuse(
        { email: 'user@example.com', password: 'x', isAdmin: true },
        SignUpRequestBodyDto,
      );

      expect(details).toEqual([
        {
          field: 'isAdmin',
          rejectedValue: true,
          issueKey: 'ISSUE_UNKNOWN_FIELD',
        },
      ]);
    });
  });
});
