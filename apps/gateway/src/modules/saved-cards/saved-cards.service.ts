import { Injectable } from '@nestjs/common';
import type {
  CreateSetupIntentResponse,
  DeleteSavedCardResponse,
  ListSavedCardsResponse,
  SavedCardResponse,
} from '@app/contracts';
import { SavedCardsGrpcClientService } from './saved-cards.grpc.client.js';

@Injectable()
export class SavedCardsService {
  constructor(private readonly grpcClient: SavedCardsGrpcClientService) {}

  createSetupIntent(accountId: string): Promise<CreateSetupIntentResponse> {
    return this.grpcClient.createSetupIntent(accountId);
  }

  confirmSetup(
    accountId: string,
    setupIntentId: string,
  ): Promise<SavedCardResponse> {
    return this.grpcClient.confirmSetup(accountId, setupIntentId);
  }

  listSavedCards(accountId: string): Promise<ListSavedCardsResponse> {
    return this.grpcClient.listSavedCards(accountId);
  }

  deleteSavedCard(
    accountId: string,
    cardId: string,
  ): Promise<DeleteSavedCardResponse> {
    return this.grpcClient.deleteSavedCard(accountId, cardId);
  }
}
