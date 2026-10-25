import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import securityService from '../../services/security/security.service.js';
import tokenService from '../../services/security/jsonWebTokens.js';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class tokenVerificationGuard implements CanActivate {
  constructor(
    private readonly _tokenService: tokenService,
    private readonly _config: ConfigService,
  ) {}
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    try {
      const decoded = this._tokenService.TokenVerify({
        token: request.decoded.token,
        secret: this._config.get<string>('TOKEN_SECRET')!,
      });

      request.decoded = decoded;
      // grpc call to identity service to get the user information
      // request.user = 

      return true;
    } catch (err) {
      throw new UnauthorizedException('invalid token');
    }
  }
}
