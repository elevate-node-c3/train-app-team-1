import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CALLER_ACCOUNT_ID_KEY, RateLimit, RequireAccess } from '@app/common';
import {
  ErrorCode,
  type ListPassengersResponseDto,
  type PassengerDto,
} from '@app/contracts';
import { IdentityService } from '../identity.service.js';
import {
  CreatePassengerDto,
  UpdatePassengerDto,
} from '../dto/passenger.dto.js';

@RequireAccess('traveller')
@Controller('passengers')
export class PassengersController {
  constructor(
    private readonly identity: IdentityService,
    private readonly cls: ClsService,
  ) {}

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'list-passengers', limit: 30, windowSeconds: 60 })
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<ListPassengersResponseDto> {
    const accountId = this.getAccountId();
    const language = this.resolveLanguage(acceptLanguage);
    return this.identity.listPassengers(accountId, language);
  }

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'add-passenger', limit: 10, windowSeconds: 60 })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async add(
    @Body() body: CreatePassengerDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<{ passenger: PassengerDto }> {
    const accountId = this.getAccountId();
    const language = this.resolveLanguage(acceptLanguage);
    const passenger = await this.identity.addPassenger({
      accountId,
      fullName: body.fullName,
      nationalId: body.nationalId,
      profileType: body.profileType,
      language,
    });
    return { passenger };
  }

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'update-passenger', limit: 10, windowSeconds: 60 })
  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() body: UpdatePassengerDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<{ passenger: PassengerDto }> {
    const accountId = this.getAccountId();
    const language = this.resolveLanguage(acceptLanguage);
    const passenger = await this.identity.updatePassenger({
      passengerId: id,
      accountId,
      fullName: body.fullName,
      nationalId: body.nationalId,
      profileType: body.profileType,
      language,
    });
    return { passenger };
  }

  @RequireAccess('traveller')
  @RateLimit({ bucket: 'delete-passenger', limit: 10, windowSeconds: 60 })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    const accountId = this.getAccountId();
    await this.identity.deletePassenger(id, accountId);
  }

  private getAccountId(): string {
    const accountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    if (!accountId) {
      throw new HttpException(
        { code: ErrorCode.UNAUTHORIZED },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return accountId;
  }

  private resolveLanguage(acceptLanguage?: string): string {
    if (
      acceptLanguage &&
      acceptLanguage.trim().toLowerCase().startsWith('en')
    ) {
      return 'en';
    }
    return 'ar';
  }
}
