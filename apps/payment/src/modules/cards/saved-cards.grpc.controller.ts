import { Controller, UseInterceptors, UsePipes } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
  toRpcException,
} from '@app/common';
import {
  PAYMENT_SERVICE_NAME,
  type CreateSetupIntentResponse,
  type DeleteSavedCardResponse,
  type ListSavedCardsResponse,
  type SavedCardResponse,
} from '@app/contracts';
import {
  ConfirmSetupRequestDto,
  CreateSetupIntentRequestDto,
  DeleteSavedCardRequestDto,
  ListSavedCardsRequestDto,
} from './dto/saved-cards-request.dto.js';
import { SavedCardsService } from './saved-cards.service.js';

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UsePipes(createGrpcValidationPipe())
export class SavedCardsGrpcController {
  constructor(private readonly savedCardsService: SavedCardsService) {}

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'CreateSetupIntent')
  async createSetupIntent(
    request: CreateSetupIntentRequestDto,
  ): Promise<CreateSetupIntentResponse> {
    try {
      return await this.savedCardsService.createSetupIntent(request.accountId);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'ConfirmSetup')
  async confirmSetup(
    request: ConfirmSetupRequestDto,
  ): Promise<SavedCardResponse> {
    try {
      const card = await this.savedCardsService.confirmSetup(
        request.accountId,
        request.setupIntentId,
      );
      return { card };
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'ListSavedCards')
  async listSavedCards(
    request: ListSavedCardsRequestDto,
  ): Promise<ListSavedCardsResponse> {
    try {
      const cards = await this.savedCardsService.listCards(request.accountId);
      return { cards };
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'DeleteSavedCard')
  async deleteSavedCard(
    request: DeleteSavedCardRequestDto,
  ): Promise<DeleteSavedCardResponse> {
    try {
      const success = await this.savedCardsService.deleteCard(
        request.accountId,
        request.cardId,
      );
      return { success };
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
