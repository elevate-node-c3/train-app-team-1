import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { revokeTokenRepo } from '../../repository/revokeToken.repo.js';

@Injectable()
export class tokenRevokeGuard implements CanActivate {
  constructor(private readonly revokeTokenRepo: revokeTokenRepo) {}
  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();
    const revokeToken = await this.revokeTokenRepo.findOne({
      where: { token: request.decoded.token },
    });
    if (revokeToken) throw new ForbiddenException('token revoked');
    return true;
  }
}
