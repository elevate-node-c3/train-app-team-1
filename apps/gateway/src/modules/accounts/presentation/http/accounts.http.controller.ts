import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { SignUpResponseDto } from '@app/contracts';
import { SignUpUseCase } from '../../application/use-cases/sign-up.use-case.js';
import { SignUpDto } from './dto/sign-up.dto.js';

/**
 * The only HTTP surface for sign-up. The global `ResponseInterceptor` wraps the
 * returned object in `ApiResponse`; the controller does not build envelopes.
 */
@Controller('identity')
export class AccountsHttpController {
  constructor(private readonly signUpUseCase: SignUpUseCase) {}

  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() body: SignUpDto): Promise<SignUpResponseDto> {
    return this.signUpUseCase.execute(body);
  }
}
