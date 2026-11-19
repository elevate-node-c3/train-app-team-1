import {
  Controller,
  Logger,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { GrpcMethod, type RpcException } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import {
  CORRELATION_ID_KEY,
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
  toRpcException as toSharedRpcException,
} from '@app/common';
import { INVENTORY_SERVICE_NAME } from '@app/contracts';
import {
  CreateHoldRequestDto,
  ExtendHoldRequestDto,
  GetHoldRequestDto,
  ReleaseHoldRequestDto,
} from './dto/hold-request.dto.js';
import { HoldSnapshotResponseDto } from './dto/hold-response.dto.js';
import { HoldCoreError } from './hold-core.errors.js';
import { HoldCoreService } from './hold-core.service.js';
import { HoldCreationGuard, HoldServiceGuard } from './hold-access.guard.js';

/** HoldCoreError carries the code and its refs; everything else is masked. */
export function toRpcException(error: unknown): RpcException {
  return toSharedRpcException(error);
}

/** Global pipes do not reach a @GrpcMethod, so the boundary declares its own. */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UseGuards(HoldServiceGuard)
@UsePipes(createGrpcValidationPipe())
export class SeatHoldGrpcController {
  private readonly logger = new Logger(SeatHoldGrpcController.name);

  constructor(
    private readonly holdCoreService: HoldCoreService,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'CreateHold')
  @UseGuards(HoldCreationGuard)
  async createHold(
    request: CreateHoldRequestDto,
  ): Promise<HoldSnapshotResponseDto> {
    try {
      return HoldSnapshotResponseDto.from(
        await this.holdCoreService.createHold(request, this.correlationId()),
      );
    } catch (error) {
      this.logger.warn(`CreateHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'GetHold')
  async getHold(request: GetHoldRequestDto): Promise<HoldSnapshotResponseDto> {
    try {
      return HoldSnapshotResponseDto.from(
        await this.holdCoreService.getHold(request, this.correlationId()),
      );
    } catch (error) {
      this.logger.warn(`GetHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'ReleaseHold')
  async releaseHold(
    request: ReleaseHoldRequestDto,
  ): Promise<HoldSnapshotResponseDto> {
    try {
      return HoldSnapshotResponseDto.from(
        await this.holdCoreService.releaseHold(request, this.correlationId()),
      );
    } catch (error) {
      this.logger.warn(`ReleaseHold error: ${safeErrorName(error)}`);
      throw toRpcException(error);
    }
  }

  @GrpcMethod(INVENTORY_SERVICE_NAME, 'ExtendHold')
  async extendHold(
    request: ExtendHoldRequestDto,
  ): Promise<HoldSnapshotResponseDto> {
    try {
      return HoldSnapshotResponseDto.from(
        await this.holdCoreService.extendHold(request, this.correlationId()),
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
