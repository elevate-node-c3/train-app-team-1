import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { tokenPayload } from '../../types/tokenPayload.type.js';
@Injectable()
class tokenService {
  constructor(
    private readonly _JWTservice: JwtService,
  ) {}

  TokenVerify({
    token,
    secret,
  }: {
    token: string;
    secret: string;
  }): tokenPayload {
    return this._JWTservice.verify(token, { secret });
  }
}

export default tokenService;
