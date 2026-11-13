import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import type {
  CompleteProfileResponseDto,
  ProfileOptionsResponseDto,
  ProfileResponseDto,
} from '@app/contracts';
import { Public, RateLimit, RequireAccess } from '@app/common';
import { IdentityService } from '../identity.service.js';
import { CompleteProfileDto } from '../dto/profile.dto.js';

@Controller('profile')
export class ProfileController {
  constructor(private readonly identity: IdentityService) {}

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'complete-profile', limit: 5, windowSeconds: 60 })
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Body() body: CompleteProfileDto,
  ): Promise<CompleteProfileResponseDto> {
    return this.identity.completeProfile(body);
  }

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'get-profile', limit: 30, windowSeconds: 60 })
  @Get()
  @HttpCode(HttpStatus.OK)
  getProfile(): Promise<ProfileResponseDto> {
    return this.identity.getProfile();
  }

  @Public()
  @RateLimit({ bucket: 'profile-options', limit: 60, windowSeconds: 60 })
  @Get('options')
  @HttpCode(HttpStatus.OK)
  getOptions(): Promise<ProfileOptionsResponseDto> {
    return this.identity.getProfileOptions();
  }
}
