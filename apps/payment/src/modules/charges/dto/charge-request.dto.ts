import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  IsOptional,
} from 'class-validator';
import type { CancelChargeRequest, StartChargeRequest } from '@app/contracts';

/** payment_charge.currency carries a CHECK for this one value. */
export const SUPPORTED_CURRENCIES = ['EGP'] as const;

/** payment_charge.idempotency_key is text; booking sends a UUID today. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * What payment accepts, matching payment.proto field for field and the
 * payment_charge CHECK constraints: a positive whole number of piastres, and
 * EGP. Refusing here answers the caller instead of letting Postgres raise a
 * constraint violation the service would have to mask as INTERNAL.
 */
export class StartChargeRequestDto implements StartChargeRequest {
  @IsUUID()
  bookingReference!: string;

  /** CHECK (amount_piastres > 0), and piastres are indivisible. */
  @IsInt()
  @Min(1)
  amountPiastres!: number;

  @IsIn(SUPPORTED_CURRENCIES)
  currency!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_IDEMPOTENCY_KEY_LENGTH)
  idempotencyKey!: string;

  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsUUID()
  savedCardId?: string;
}

export class CancelChargeRequestDto implements CancelChargeRequest {
  @IsUUID()
  bookingReference!: string;

  @IsUUID()
  paymentReference!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_IDEMPOTENCY_KEY_LENGTH)
  idempotencyKey!: string;
}
