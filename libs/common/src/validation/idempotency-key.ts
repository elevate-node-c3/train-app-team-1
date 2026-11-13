import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@app/contracts';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Safe retries need an Idempotency-Key header; reject missing keys here. */
export function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (key) return key;

  throw new HttpException(
    {
      code: ErrorCode.VALIDATION_ERROR,
      message: [
        {
          field: IDEMPOTENCY_KEY_HEADER,
          rejectedValue: value,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
          actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
        },
      ],
    },
    HttpStatus.BAD_REQUEST,
  );
}
