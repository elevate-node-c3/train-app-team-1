import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { accessRolesGuard } from './accessRole.guard.js';

export const access_roles = 'ACCESS_ROLES';
export function authorizationGuard(roles: string[]) {
  return applyDecorators(
    SetMetadata(access_roles, roles),
    UseGuards(accessRolesGuard),
  );
}
