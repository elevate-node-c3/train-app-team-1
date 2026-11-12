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

/** How long the gateway waits for an operator write or an audit read. */
export const OPERATIONS_CALL_TIMEOUT_MS = 5000;

/** Lower-cased by grpc-js regardless of how this is written. */
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

  /**
   * A read, not a change -- BR-52 governs attribution for changes, so unlike
   * the two writes above this carries no `Idempotency-Key`, matching the
   * catalog-side `OperationsGrpcController.listAuditEntries`.
   */
  async listAuditEntries(
    request: ListAuditEntriesGrpcRequest,
  ): Promise<ListAuditEntriesGrpcResponse> {
    return this.call(undefined, (client, metadata, options) =>
      client.listAuditEntries(request, metadata, options),
    );
  }

  /**
   * One call to catalog: caller metadata in, the idempotency key in when
   * given, a deadline on it, errors mapped -- the same shape
   * `CatalogGrpcClientService.call` uses, so a method that forgot the
   * deadline would be exactly as invisible until production.
   */
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

  /**
   * A business refusal first, then the transport status -- identical
   * ordering to `CatalogGrpcClientService.toHttpError`, which already maps
   * DEADLINE_EXCEEDED to 504 and UNAVAILABLE to 503 with a retry hint.
   */
  private toHttpError(error: unknown): unknown {
    const business = parseCatalogBusinessError(error);
    if (business) return business;

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      this.logger.warn(`Catalog operations call failed with gRPC status ${code}`);
      return grpcStatusException(code);
    }

    // An rxjs TimeoutError, which has no gRPC status: report it as the
    // deadline it is rather than letting it become a 500.
    if (error instanceof Error && error.name === 'TimeoutError') {
      this.logger.warn('Catalog operations call exceeded its deadline locally');
      return grpcStatusException(4); // DEADLINE_EXCEEDED
    }

    return error;
  }
}
