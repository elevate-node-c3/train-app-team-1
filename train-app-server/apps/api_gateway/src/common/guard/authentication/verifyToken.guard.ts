import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';

export class verifyTokenGuard implements CanActivate {
  constructor() {}
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    const [bearer, authorization] =
      request.headers['authorization']?.split(' ')!;

    let tokenVerify;
    // add token to request
    return true;
  }
}
