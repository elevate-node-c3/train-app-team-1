import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import type { SignUpResponseDto } from '@app/contracts';
import {
  ACCOUNTS_CLIENT,
  type AccountsClientPort,
} from '../../application/ports/accounts.port.js';
import { SignUpDto } from './dto/sign-up.dto.js';

/**
 * The only HTTP surface for sign-up. The global `ResponseInterceptor` wraps the
 * returned object in `ApiResponse`; the controller does not build envelopes.
 *
 * Injects the port directly: there is no sign-up rule at the gateway, and a
 * use-case whose body is `return this.accounts.signUp(input)` only adds a hop.
 */
@Controller('identity')
export class AccountsHttpController {
  constructor(
    @Inject(ACCOUNTS_CLIENT) private readonly accounts: AccountsClientPort,
  ) {}

  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() body: SignUpDto): Promise<SignUpResponseDto> {
    return this.accounts.signUp(body);
  }
}
