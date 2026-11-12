import { createValidationPipe } from '@app/common';
import { describe, expect, it } from 'vitest';

import { ResetPasswordDto, SignUpDto, VerifyEmailDto } from './auth.dto.js';

describe.each([
  {
    name: 'email verification',
    metatype: VerifyEmailDto,
    validInput: { email: 'traveller@example.com', code: '123456' },
  },
  {
    name: 'password reset',
    metatype: ResetPasswordDto,
    validInput: {
      email: 'traveller@example.com',
      code: '123456',
      newPassword: 'long-password',
    },
  },
])('$name through the real validation pipe', ({ metatype, validInput }) => {
  it.each(['12345', '1234567', '12345x'])(
    'keeps the six-digit-code context for %s',
    async (code) => {
      await expect(
        createValidationPipe().transform(
          { ...validInput, code },
          { type: 'body', metatype },
        ),
      ).rejects.toMatchObject({
        response: {
          message: [
            {
              field: 'code',
              rejectedValue: code,
              issueKey: 'ISSUE_VERIFICATION_CODE_FORMAT',
            },
          ],
        },
      });
    },
  );

  it('preserves exactly six digits including a leading zero', async () => {
    const dto = await createValidationPipe().transform(
      { ...validInput, code: '012345' },
      {
        type: 'body',
        metatype,
      },
    );

    expect(dto).toBeInstanceOf(metatype);
    expect(dto.code).toBe('012345');
  });
});

describe('password length details through the real validation pipe', () => {
  it.each([
    { password: 'short', issueKey: 'ISSUE_TEXT_TOO_SHORT' },
    { password: 'x'.repeat(73), issueKey: 'ISSUE_TEXT_TOO_LONG' },
  ])(
    'keeps the $issueKey meaning without numeric decorator introspection',
    async ({ password, issueKey }) => {
      await expect(
        createValidationPipe().transform(
          { email: 'traveller@example.com', password },
          {
            type: 'body',
            metatype: SignUpDto,
          },
        ),
      ).rejects.toMatchObject({
        response: {
          message: [{ field: 'password', rejectedValue: password, issueKey }],
        },
      });
    },
  );
});
