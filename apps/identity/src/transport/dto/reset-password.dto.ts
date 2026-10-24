import {
  IsByteLength,
  IsEmail,
  IsString,
  IsStrongPassword,
  Matches,
} from 'class-validator';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_POLICY,
} from '../../domain/password/password-policy.js';

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @IsStrongPassword(PASSWORD_POLICY)
  @IsByteLength(0, PASSWORD_MAX_BYTES)
  newPassword: string;

  @IsString()
  confirmPassword: string;
}
