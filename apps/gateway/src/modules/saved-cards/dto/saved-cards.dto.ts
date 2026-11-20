import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class ConfirmSetupDto {
  @IsString()
  @IsNotEmpty()
  setupIntentId!: string;
}

export class SavedCardParamDto {
  @IsUUID()
  @IsNotEmpty()
  cardId!: string;
}
