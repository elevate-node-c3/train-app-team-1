import { Inject, Injectable } from '@nestjs/common';
import type { SignUpRequestDto, SignUpResponseDto } from '@app/contracts';
import {
  ACCOUNTS_CLIENT,
  type AccountsClientPort,
} from '../ports/accounts.port.js';

@Injectable()
export class SignUpUseCase {
  constructor(
    @Inject(ACCOUNTS_CLIENT) private readonly accounts: AccountsClientPort,
  ) {}

  async execute(input: SignUpRequestDto): Promise<SignUpResponseDto> {
    return this.accounts.signUp(input);
  }
}
