import { IsNotEmpty, IsString, IsUUID, Matches } from 'class-validator';

export class ConfirmSetupDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^seti_[a-zA-Z0-9]+$/)
  setupIntentId!: string;
}

export class SavedCardParamDto {
  @IsUUID()
  @IsNotEmpty()
  cardId!: string;
}
