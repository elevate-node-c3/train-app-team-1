import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import type {
  ConfirmTicketCancellationRequest,
  PreviewTicketCancellationRequest,
} from '@app/contracts';

export class PreviewTicketCancellationRequestDto
  implements PreviewTicketCancellationRequest
{
  @IsUUID()
  ticketId!: string;
}

export class ConfirmTicketCancellationRequestDto
  implements ConfirmTicketCancellationRequest
{
  @IsUUID()
  ticketId!: string;

  @IsIn(['FULL', 'HALF'])
  tier!: 'FULL' | 'HALF';

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey!: string;
}
