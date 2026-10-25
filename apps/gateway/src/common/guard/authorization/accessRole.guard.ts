import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { access_roles } from './authorization.guard.js';
import { Request } from 'express';

@Injectable()
export class accessRolesGuard implements CanActivate {
  constructor(public reflector: Reflector) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    let req: Request;
    const roles = this.reflector.get(
      access_roles,
      context.getHandler,
    ) as string[];

    if (context.getType() === 'http') {
      req = context.switchToHttp().getRequest();
    } else if (context.getType() === 'rpc') {
      req = context.switchToRpc().getContext();
    } else {
      req = context.switchToWs().getClient();
    }

    if (!roles.includes(req.decoded.userRole))
      throw new UnauthorizedException(
        'you are not allowed to access this operation',
      );

    return true;
  }
}
