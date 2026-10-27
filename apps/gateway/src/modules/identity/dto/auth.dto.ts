import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { EventLanguage } from '@app/contracts';

const CODE_PATTERN = /^\d{6}$/;

export class SignUpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}

export class VerifyEmailDto {
  @IsEmail()
  email!: string;

  @Matches(CODE_PATTERN, { message: 'code must be six digits' })
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}

export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}

export class SignInDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class SignOutDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  @Matches(CODE_PATTERN, { message: 'code must be six digits' })
  code!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
