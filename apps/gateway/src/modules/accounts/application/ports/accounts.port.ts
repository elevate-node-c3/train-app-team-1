import type { SignUpRequestDto, SignUpResponseDto } from '@app/contracts';

export const ACCOUNTS_CLIENT = Symbol('ACCOUNTS_CLIENT');

/**
 * The gateway's view of identity. The use-case depends on this interface, not
 * on `@grpc/grpc-js`, so the transport can be replaced in a test with an object
 * literal and no channel.
 */
export interface AccountsClientPort {
  signUp(input: SignUpRequestDto): Promise<SignUpResponseDto>;
}
