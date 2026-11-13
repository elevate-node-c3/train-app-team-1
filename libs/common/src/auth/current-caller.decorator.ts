import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessLevel, StaffRole } from '@app/contracts';

/** Caller claims verified by the gateway guard, never supplied by the client. */
export interface AuthenticatedCaller {
  accountId: string;
  sessionId: string;
  jti: string;
  level: AccessLevel;
  roles: StaffRole[];
  bookable: boolean;
  expiresAt: number;
}

export const CurrentCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedCaller => {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedCaller }>();
    if (!request.user) {
      throw new Error('CurrentCaller used without JwtAuthGuard');
    }
    return request.user;
  },
);
