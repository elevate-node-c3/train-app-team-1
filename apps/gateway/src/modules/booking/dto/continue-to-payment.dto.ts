import { IsOptional, IsUUID } from 'class-validator';
import type { ContinueToPaymentRequest } from '@app/contracts';

export class ContinueToPaymentDto implements Partial<ContinueToPaymentRequest> {
  @IsOptional()
  @IsUUID()
  savedCardId?: string;
}
