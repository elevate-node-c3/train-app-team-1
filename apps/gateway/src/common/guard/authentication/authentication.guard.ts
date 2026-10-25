import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { tokenSignatureGuard } from './tokenSignature.guard.js';
import { tokenRevokeGuard } from './tokenRevokness.guard.js';
import { tokenVerificationGuard } from './tokenVerification.guard.js';

export function authenticationGuard(roles: string[]) {
  const access_roles = 'ACCESS_ROLES';
  return applyDecorators(
    SetMetadata(access_roles, roles),
    UseGuards(tokenSignatureGuard, tokenRevokeGuard, tokenVerificationGuard),
  );
}