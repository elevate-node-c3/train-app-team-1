import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreatePassengerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  nationalId!: string;

  @IsString()
  @IsNotEmpty()
  profileType!: string;
}

export class UpdatePassengerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  nationalId!: string;

  @IsString()
  @IsNotEmpty()
  profileType!: string;
}

export { CreatePassengerDto as CreatePassengerHttpDto };
export { UpdatePassengerDto as UpdatePassengerHttpDto };
