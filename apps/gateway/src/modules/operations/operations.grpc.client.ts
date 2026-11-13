import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { createGrpcMetadataWithCaller, grpcStatusException } from '@app/common';

import { parseCatalogBusinessError } from '../catalog/catalog-error.js';
import {
  OPERATIONS_GRPC_CLIENT,
  type ChangeFareGrpcRequest,
  type ChangeFareGrpcResponse,
  type ListAuditEntriesGrpcRequest,
  type ListAuditEntriesGrpcResponse,
  type OperationsGrpcClient,
  type PublishTimetableGrpcRequest,
  type PublishTimetableGrpcResponse,
} from './operations.types.js';

/** Maximum wait for operations RPCs. */
export const OPERATIONS_CALL_TIMEOUT_MS = 5000;

/** grpc-js lowercases this metadata key. */
const IDEMPOTENCY_KEY_METADATA_KEY = 'idempotency-key';

@Injectable()
export class OperationsGrpcClientService {
  private readonly logger = new Logger(OperationsGrpcClientService.name);

  constructor(
    @Inject(OPERATIONS_GRPC_CLIENT)
    private readonly client: OperationsGrpcClient,
    private readonly cls: ClsService,
  ) {}

  async publishTimetable(
    request: PublishTimetableGrpcRequest,
    idempotencyKey: string,
  ): Promise<PublishTimetableGrpcResponse> {
    return this.call(idempotencyKey, (client, metadata, options) =>
      client.publishTimetable(request, metadata, options),
    );
  }

  async changeFare(
    request: ChangeFareGrpcRequest,
    idempotencyKey: string,
  ): Promise<ChangeFareGrpcResponse> {
    return this.call(idempotencyKey, (client, metadata, options) =>
      client.changeFare(request, metadata, options),
    );
  }

  /** Reads need no idempotency key; only changes need audit attribution. */
  async listAuditEntries(
    request: ListAuditEntriesGrpcRequest,
  ): Promise<ListAuditEntriesGrpcResponse> {
    return this.call(undefined, (client, metadata, options) =>
      client.listAuditEntries(request, metadata, options),
    );
  }

  /** Share caller metadata, deadlines, and gRPC-to-HTTP error mapping. */
  private async call<T>(
    idempotencyKey: string | undefined,
    invoke: (
      client: OperationsGrpcClient,
      metadata: Metadata,
      options: { deadline: number },
    ) => Observable<T>,
  ): Promise<T> {
    const metadata = createGrpcMetadataWithCaller(this.cls);
    if (idempotencyKey) {
      metadata.set(IDEMPOTENCY_KEY_METADATA_KEY, idempotencyKey);
    }
    const deadline = Date.now() + OPERATIONS_CALL_TIMEOUT_MS;

    try {
      return await firstValueFrom(
        invoke(this.client, metadata, { deadline }).pipe(
          timeout(OPERATIONS_CALL_TIMEOUT_MS + 500),
        ),
      );
    } catch (error: unknown) {
      throw this.toHttpError(error);
    }
  }

  /** Prefer business errors, then fall back to transport status. */
  private toHttpError(error: unknown): unknown {
    const business = parseCatalogBusinessError(error);
    if (business) return business;

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      this.logger.warn(`Catalog operations call failed with gRPC status ${code}`);
      return grpcStatusException(code);
    }

    // Map local RxJS timeouts to DEADLINE_EXCEEDED, not 500.
    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('Catalog operations call exceeded its deadline locally');
      return grpcStatusException(4); // DEADLINE_EXCEEDED
    }

    return error;
  }
}
