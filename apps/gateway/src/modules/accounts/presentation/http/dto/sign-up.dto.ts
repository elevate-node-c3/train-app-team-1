import { IsEmail, IsIn, IsOptional } from 'class-validator';
import type { EventLanguage } from '@app/contracts';

/**
 * The HTTP edge validates before the gRPC call. `language` is optional and
 * defaults to Arabic downstream (BR-56); an unknown value is a client error
 * rather than a silently coerced locale.
 */
export class SignUpDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
