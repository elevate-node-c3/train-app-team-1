import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  CurrentCaller,
  RequireAccess,
  type AuthenticatedCaller,
} from '@app/common';
import type {
  CreateSetupIntentResponse,
  DeleteSavedCardResponse,
  ListSavedCardsResponse,
  SavedCardResponse,
} from '@app/contracts';
import { SavedCardsService } from './saved-cards.service.js';
import { ConfirmSetupDto, SavedCardParamDto } from './dto/saved-cards.dto.js';

@RequireAccess('traveller')
@Controller('saved-cards')
export class SavedCardsController {
  constructor(private readonly savedCardsService: SavedCardsService) {}

  @Post('setup')
  @HttpCode(HttpStatus.CREATED)
  createSetupIntent(
    @CurrentCaller() caller: AuthenticatedCaller,
  ): Promise<CreateSetupIntentResponse> {
    return this.savedCardsService.createSetupIntent(caller.accountId);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmSetup(
    @CurrentCaller() caller: AuthenticatedCaller,
    @Body() dto: ConfirmSetupDto,
  ): Promise<SavedCardResponse> {
    return this.savedCardsService.confirmSetup(
      caller.accountId,
      dto.setupIntentId,
    );
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  listSavedCards(
    @CurrentCaller() caller: AuthenticatedCaller,
  ): Promise<ListSavedCardsResponse> {
    return this.savedCardsService.listSavedCards(caller.accountId);
  }

  @Delete(':cardId')
  @HttpCode(HttpStatus.OK)
  deleteSavedCard(
    @CurrentCaller() caller: AuthenticatedCaller,
    @Param() param: SavedCardParamDto,
  ): Promise<DeleteSavedCardResponse> {
    return this.savedCardsService.deleteSavedCard(
      caller.accountId,
      param.cardId,
    );
  }
}
