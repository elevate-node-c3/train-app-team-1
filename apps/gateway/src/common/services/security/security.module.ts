import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import tokenService from './jsonWebTokens.js';
import securityService from './security.service.js';

@Module({
  imports: [JwtService],
  providers: [securityService, ConfigService, tokenService],
  exports: [securityService, tokenService],
})
class securityModule {}

export default securityModule;
