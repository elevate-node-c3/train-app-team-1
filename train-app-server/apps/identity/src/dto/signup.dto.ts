
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'passwordConfirmation', async: false })
class PasswordConfirmationConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, args: ValidationArguments): boolean {
    const body = args.object as SignupDto;
    return typeof value === 'string' && value === body.password;
  }

  defaultMessage(): string {
    return "Password doesn't match";
  }
}

export class SignupDto {
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
  password!: string;

  @IsString()
  @Validate(PasswordConfirmationConstraint)
  confirmPassword!: string;

  @IsString()
  @MaxLength(35)
  language!: string;
}
