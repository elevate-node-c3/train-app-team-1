import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import {
  createGrpcMetadataWithCaller,
  decodeRefusal,
  grpcStatusException,
  refusalHttpException,
} from '@app/common';
import {
  GRPC_STATUS,
  type CreateSetupIntentResponse,
  type DeleteSavedCardResponse,
  type ListSavedCardsResponse,
  type SavedCardResponse,
} from '@app/contracts';
import {
  PAYMENT_GRPC_CLIENT,
  type PaymentGrpcClient,
} from './saved-cards.types.js';

export const SAVED_CARDS_REQUEST_TIMEOUT_MS = 6_000;
const TIMEOUT_GRACE_MS = 250;

@Injectable()
export class SavedCardsGrpcClientService {
  private readonly logger = new Logger(SavedCardsGrpcClientService.name);

  constructor(
    @Inject(PAYMENT_GRPC_CLIENT) private readonly client: PaymentGrpcClient,
    private readonly cls: ClsService,
  ) {}

  createSetupIntent(accountId: string): Promise<CreateSetupIntentResponse> {
    return this.call((metadata, options) =>
      this.client.createSetupIntent({ accountId }, metadata, options),
    );
  }

  confirmSetup(
    accountId: string,
    setupIntentId: string,
  ): Promise<SavedCardResponse> {
    return this.call((metadata, options) =>
      this.client.confirmSetup({ accountId, setupIntentId }, metadata, options),
    );
  }

  listSavedCards(accountId: string): Promise<ListSavedCardsResponse> {
    return this.call((metadata, options) =>
      this.client.listSavedCards({ accountId }, metadata, options),
    );
  }

  deleteSavedCard(
    accountId: string,
    cardId: string,
  ): Promise<DeleteSavedCardResponse> {
    return this.call((metadata, options) =>
      this.client.deleteSavedCard({ accountId, cardId }, metadata, options),
    );
  }

  private async call<T>(
    invoke: (
      metadata: Metadata,
      options: { deadline: number },
    ) => Observable<T>,
  ): Promise<T> {
    const deadline = Date.now() + SAVED_CARDS_REQUEST_TIMEOUT_MS;

    try {
      return await firstValueFrom(
        invoke(createGrpcMetadataWithCaller(this.cls), { deadline }).pipe(
          timeout(SAVED_CARDS_REQUEST_TIMEOUT_MS + TIMEOUT_GRACE_MS),
        ),
      );
    } catch (error: unknown) {
      throw this.httpErrorFor(error);
    }
  }

  private httpErrorFor(error: unknown): unknown {
    const refusal = decodeRefusal((error as { details?: unknown })?.details);
    if (refusal) return refusalHttpException(refusal);

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      if (
        code === GRPC_STATUS.UNAVAILABLE ||
        code === GRPC_STATUS.DEADLINE_EXCEEDED
      ) {
        this.logger.warn(`payment call failed with gRPC status ${code}`);
      }
      return grpcStatusException(code);
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('payment call exceeded its deadline');
      return grpcStatusException(GRPC_STATUS.DEADLINE_EXCEEDED);
    }

    return error;
  }
}
