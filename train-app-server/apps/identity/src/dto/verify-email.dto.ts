import { IsEmail, IsString, Matches } from "class-validator";



export class VerifyEmailDto {
  @IsEmail()
  email!: string;

  // لازم يكون 6 أرقام، ومسموح يبدأ بصفر
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}