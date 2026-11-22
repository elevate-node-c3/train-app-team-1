import {
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type {
  CompleteProfileRequestDto,
  SupportedLanguage,
  ForgotPasswordRequestDto,
  RefreshTokenRequestDto,
  ResendVerificationRequestDto,
  ResetPasswordRequestDto,
  ResolveHoldPassengersRequest,
  ResolveNotificationRecipientRequest,
  SignInRequestDto,
  SignOutRequestDto,
  SignUpRequestDto,
  VerifyEmailRequestDto,
} from '@app/contracts';

/**
 * What identity accepts over gRPC. The gateway validates at the edge too; a
 * peer being internal does not make it trusted.
 *
 * Two kinds of field appear here.
 *
 * Identifiers, dates and emails are checked, because nothing else checked
 * them and an account id reaches a uuid column.
 *
 * The rest carry only @IsString, which proto3 always satisfies, so they pass
 * through untouched. They must still be declared: the pipe whitelists, so a
 * field with no decorator at all would be stripped and then refused. Their
 * meaning belongs to the validators that answer with a code a client can act
 * on -- INVALID_NATIONAL_ID_CENTURY, INVALID_FULL_NAME, INVALID_PHONE_FORMAT,
 * INVALID_VERIFICATION_CODE and the rest. A rule here would fire first and
 * flatten every one of them into VALIDATION_ERROR.
 */

/** Long enough for any real address, short enough to not be a payload. */
const MAX_EMAIL_LENGTH = 254;

/**
 * The proto's domain: a language the gateway already resolved, or '' for no
 * preference. The controller turns '' into absent, which is what the services
 * mean by it -- languageOf falls back to Arabic either way.
 */
const LANGUAGES: readonly (SupportedLanguage | '')[] = ['ar', 'en', ''];

class LanguagePreference {
  @IsIn(LANGUAGES)
  @IsOptional()
  language?: SupportedLanguage | '';
}

// Omit language: the DTO follows the proto, which allows '' for no preference,
// while the contract interface narrows it to a resolved SupportedLanguage.
export class SignUpRequestBodyDto
  extends LanguagePreference
  implements Omit<SignUpRequestDto, 'language'>
{
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;

  /** The password policy and its codes are PasswordsService's. */
  @IsString()
  password!: string;
}

export class VerifyEmailRequestBodyDto implements VerifyEmailRequestDto {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;

  /**
   * Checked by the service, which answers INVALID_VERIFICATION_CODE. Refusing
   * a malformed code here would also tell a caller which of the two it was.
   */
  @IsString()
  code!: string;

  @IsString()
  @IsOptional()
  deviceId?: string;
}

export class ResendVerificationRequestBodyDto implements ResendVerificationRequestDto {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;
}

export class SignInRequestBodyDto implements SignInRequestDto {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;

  /** An empty password must read as INVALID_CREDENTIALS, not as a bad shape. */
  @IsString()
  password!: string;

  @IsString()
  @IsOptional()
  deviceId?: string;
}

export class RefreshTokenRequestBodyDto implements RefreshTokenRequestDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class SignOutRequestBodyDto implements SignOutRequestDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;

  /**
   * Carried but not trusted: the controller reads the session and jti from the
   * gateway's verified metadata. They are token claims, not UUIDs.
   */
  @IsString()
  sessionId!: string;

  @IsString()
  jti!: string;

  @IsISO8601()
  accessTokenExpiresAt!: string;
}

export class ForgotPasswordRequestBodyDto implements ForgotPasswordRequestDto {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;
}

export class ResetPasswordRequestBodyDto implements ResetPasswordRequestDto {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;

  @IsString()
  code!: string;

  @IsString()
  newPassword!: string;
}

/** Every field belongs to profile-validation.ts, which names each refusal. */
export class CompleteProfileRequestBodyDto implements CompleteProfileRequestDto {
  @IsString()
  fullName!: string;

  @IsString()
  phoneNumber!: string;

  @IsString()
  nationalId!: string;

  @IsString()
  profileType!: string;

  @IsString()
  nationality!: string;
}

export class ListPassengersRequestBodyDto extends LanguagePreference {
  @IsUUID()
  accountId!: string;
}

export class AddPassengerRequestBodyDto extends LanguagePreference {
  @IsUUID()
  accountId!: string;

  @IsString()
  fullName!: string;

  @IsString()
  nationalId!: string;

  @IsString()
  profileType!: string;
}

export class UpdatePassengerRequestBodyDto extends AddPassengerRequestBodyDto {
  @IsUUID()
  passengerId!: string;
}

export class DeletePassengerRequestBodyDto {
  @IsUUID()
  passengerId!: string;

  @IsUUID()
  accountId!: string;
}

/**
 * Booking's private call. The refs and trip ids reach uuid columns, and a
 * malformed one would surface as a masked INTERNAL rather than an answer.
 */
export class ResolveHoldPassengersRequestBodyDto implements ResolveHoldPassengersRequest {
  @IsUUID()
  ownerId!: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  passengerRefs!: string[];

  @IsArray()
  @IsUUID(undefined, { each: true })
  tripIds!: string[];
}

export class ResolveNotificationRecipientRequestBodyDto implements ResolveNotificationRecipientRequest {
  @IsUUID()
  accountId!: string;
}
