import { IsIn } from 'class-validator';

/** The refund tier the traveller accepted; booking recomputes it anyway. */
export class ConfirmTicketCancellationDto {
  @IsIn(['FULL', 'HALF'])
  tier!: 'FULL' | 'HALF';
}
