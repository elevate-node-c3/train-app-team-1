import { Controller, Logger, UseGuards, UseInterceptors } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { ClsService } from 'nestjs-cls';
import { CORRELATION_ID_KEY, GrpcCorrelationInterceptor } from '@app/common';
import {
  INVENTORY_SERVICE_NAME,
  ErrorCode,
  type CreateHoldRequest,
  type CreateHoldResponse,
  type ExtendHoldRequest,
  type ExtendHoldResponse,
  type GetHoldRequest,
  type GetHoldResponse,
  type ReleaseHoldRequest,
  type ReleaseHoldResponse,
} from '@app/contracts';
import { HoldCoreError } from './hold-core.errors.js';
import { HoldCoreService } from './hold-core.service.js';
import { HoldCreationGuard, HoldServiceGuard } from './hold-access.guard.js';

export function toRpcException(error: unknown): unknown {
  if (error instanceof RpcException) return error;

  if (error instanceof HoldCoreError) {
    return new RpcException({
      code: grpcStatusFor(error.code),
      details: JSON.stringify({
        code: error.code,
        ...(error.availableCount !== undefined
          ? { availableCount: error.availableCount }
          : {}),
        ...(error.passengerRef !== undefined
          ? { passengerRef: error.passengerRef }
          : {}),
      }),
      message: error.message,
    });
  }

  // SQL errors can contain identity values in their message and detail fields.
  return new RpcException({
    code: grpc.status.INTERNAL,
    details: JSON.stringify({ code: ErrorCode.INTERNAL_SERVER_ERROR }),
    message: 'The hold operation could not be completed.',
  });
}

function grpcStatusFor(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.HOLD_NOT_FOUND:
    case ErrorCode.RESOURCE_NOT_FOUND:
      return grpc.status.NOT_FOUND;
    case ErrorCode.SEAT_TAKEN:
    case ErrorCode.SEAT_ALREADY_TAKEN:
    case ErrorCode.PASSENGER_OVERLAP:
    case ErrorCode.BOOKING_KEY_CONFLICT:
    case ErrorCode.CONFLICT:
      return grpc.status.ABORTED;
    case ErrorCode.INSUFFICIENT_SEATS:
    case ErrorCode.SALES_CLOSED:
    case ErrorCode.HOLD_TERMINAL:
    case ErrorCode.EXTENSION_NOT_ALLOWED:
      return grpc.status.FAILED_PRECONDITION;
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.BAD_REQUEST:
    case ErrorCode.INVALID_PAYLOAD:
      return grpc.status.INVALID_ARGUMENT;
    case ErrorCode.FORBIDDEN:
    case ErrorCode.UNAUTHORIZED:
      return grpc.status.PERMISSION_DENIED;
    default:
      return grpc.status.INTERNAL;
  }
}

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UseGuards(HoldServiceGuard)
export class SeatHoldGrpcController {
  private readonly logger = new Logger(SeatHoldGrpcController.name);

  constructor(
    private readonly holdCoreService: HoldCoreService,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'CreateHold')
  @UseGuards(HoldCreationGuard)
  async createHold(request: CreateHoldRequest): Promise<CreateHoldResponse> {
    try {
      return await this.holdCoreService.createHold(
        request,
        this.correlationId(),
      );
    } catch (error) {
      this.logger.warn(`CreateHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'GetHold')
  async getHold(request: GetHoldRequest): Promise<GetHoldResponse> {
    try {
      return await this.holdCoreService.getHold(request, this.correlationId());
    } catch (error) {
      this.logger.warn(`GetHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'ReleaseHold')
  async releaseHold(request: ReleaseHoldRequest): Promise<ReleaseHoldResponse> {
    try {
      return await this.holdCoreService.releaseHold(
        request,
        this.correlationId(),
      );
    } catch (error) {
      this.logger.warn(`ReleaseHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'ExtendHold')
  async extendHold(request: ExtendHoldRequest): Promise<ExtendHoldResponse> {
    try {
      return await this.holdCoreService.extendHold(
        request,
        this.correlationId(),
      );
    } catch (error) {
      this.logger.warn(`ExtendHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  /** Use the interceptor's metadata correlation, or let the service mint one. */
  private correlationId(): string | undefined {
    return this.cls.get<string>(CORRELATION_ID_KEY);
  }
}

/** Never log tokens, SQL detail, or raw database errors from a request. */
function safeErrorName(error: unknown): string {
  if (error instanceof HoldCoreError) return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}
