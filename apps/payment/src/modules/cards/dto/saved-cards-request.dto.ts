import { IsNotEmpty, IsString, IsUUID, Matches } from 'class-validator';
import type {
  ConfirmSetupRequest,
  CreateSetupIntentRequest,
  DeleteSavedCardRequest,
  ListSavedCardsRequest,
} from '@app/contracts';

export class CreateSetupIntentRequestDto implements CreateSetupIntentRequest {
  @IsUUID()
  @IsNotEmpty()
  accountId!: string;
}

export class ConfirmSetupRequestDto implements ConfirmSetupRequest {
  @IsUUID()
  @IsNotEmpty()
  accountId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^seti_[a-zA-Z0-9]+$/)
  setupIntentId!: string;
}

export class ListSavedCardsRequestDto implements ListSavedCardsRequest {
  @IsUUID()
  @IsNotEmpty()
  accountId!: string;
}

export class DeleteSavedCardRequestDto implements DeleteSavedCardRequest {
  @IsUUID()
  @IsNotEmpty()
  accountId!: string;

  @IsUUID()
  @IsNotEmpty()
  cardId!: string;
}
