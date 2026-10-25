import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Observable } from 'rxjs';

@Injectable()
export class tokenSignatureGuard implements CanActivate {
  constructor(private readonly _config: ConfigService) {}
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    const [bearer, authorization] =
      request.headers['authorization']!.split(' ');
    if (!authorization) throw new BadRequestException('invalid token');
    if (bearer != this._config.get<string>('TOKEN_BEARER'))
      throw new BadRequestException('invalid token');
    request.decoded.token = authorization;
    return true;
  }
}
