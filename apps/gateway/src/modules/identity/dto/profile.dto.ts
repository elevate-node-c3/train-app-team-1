import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CompleteProfileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber!: string;

  @IsString()
  @IsNotEmpty()
  nationalId!: string;

  @IsString()
  @IsNotEmpty()
  profileType!: string;

  @IsString()
  @IsNotEmpty()
  nationality!: string;
}
