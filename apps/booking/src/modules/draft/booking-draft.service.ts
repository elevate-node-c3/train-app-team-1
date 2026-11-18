import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ClientGrpc } from '@nestjs/microservices';
import type { Repository } from 'typeorm';
import { firstValueFrom, isObservable, type Observable } from 'rxjs';
import {
  AllocationOutcome,
  ErrorCode,
  INVENTORY_SERVICE_NAME,
  SEATS_SPLIT_NOTICE,
  type HoldSeatsRequest,
  type HoldSeatsResponse,
  type ReleaseSeatsRequest,
  type ReleaseSeatsResponse,
} from '@app/contracts';
import {
  BookingDraftEntity,
  type BookingDraftLeg,
} from './entities/booking-draft.entity.js';
import type {
  BookingDraftLegInput,
  BookingDraftResponse,
  CreateBookingDraftDto,
} from './dto/create-booking-draft.dto.js';

export const INVENTORY_GRPC_CLIENT = 'INVENTORY_GRPC_CLIENT';

export interface InventoryGrpcService {
  holdSeats(
    request: HoldSeatsRequest,
  ): Observable<HoldSeatsResponse> | Promise<HoldSeatsResponse>;
  releaseSeats(
    request: ReleaseSeatsRequest,
  ): Observable<ReleaseSeatsResponse> | Promise<ReleaseSeatsResponse>;
}

export class BookingDraftError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly availableCount?: number,
  ) {
    super(message ?? code);
    this.name = 'BookingDraftError';
  }
}

export function extractErrorDetails(error: unknown): {
  code: ErrorCode;
  message: string;
  availableCount?: number;
} {
  if (error instanceof BookingDraftError) {
    return {
      code: error.code,
      message: error.message,
      availableCount: error.availableCount,
    };
  }

  if (error && typeof error === 'object') {
    const err = error as Record<string, any>;
    let code: ErrorCode | undefined = err.code;
    let availableCount: number | undefined = err.availableCount;
    let message: string | undefined = err.message;

    if (typeof err.details === 'string') {
      try {
        const parsed = JSON.parse(err.details);
        if (parsed.code) code = parsed.code;
        if (parsed.availableCount !== undefined) {
          availableCount = parsed.availableCount;
        }
      } catch {
        if (Object.values(ErrorCode).includes(err.details as ErrorCode)) {
          code = err.details as ErrorCode;
        }
      }
    } else if (err.details && typeof err.details === 'object') {
      if (err.details.code) code = err.details.code;
      if (err.details.availableCount !== undefined) {
        availableCount = err.details.availableCount;
      }
    }

    if (code && Object.values(ErrorCode).includes(code)) {
      return {
        code,
        message: message ?? code,
        availableCount,
      };
    }
  }

  return {
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    message: error instanceof Error ? error.message : String(error),
  };
}

function determinePassengerCount(dto: CreateBookingDraftDto): number {
  if (Array.isArray(dto.passengers)) {
    return dto.passengers.length;
  }
  if (typeof dto.passengerCount === 'number') {
    return dto.passengerCount;
  }
  if (typeof dto.groupSize === 'number') {
    return dto.groupSize;
  }
  return 0;
}

function extractPassengerNames(
  dto: CreateBookingDraftDto,
  count: number,
): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    let name = 'Passenger';
    if (Array.isArray(dto.passengers) && dto.passengers[i]) {
      const p = dto.passengers[i];
      if (typeof p === 'string' && p.trim().length > 0) {
        name = p.trim();
      } else if (
        typeof p === 'object' &&
        p.fullName &&
        typeof p.fullName === 'string' &&
        p.fullName.trim().length > 0
      ) {
        name = p.fullName.trim();
      }
    }
    names.push(name);
  }
  return names;
}

@Injectable()
export class BookingDraftService implements OnModuleInit {
  private readonly logger = new Logger(BookingDraftService.name);
  private inventoryService!: InventoryGrpcService;

  constructor(
    @InjectRepository(BookingDraftEntity)
    private readonly draftRepository: Repository<BookingDraftEntity>,
    @Inject(INVENTORY_GRPC_CLIENT)
    private readonly client: ClientGrpc | InventoryGrpcService,
  ) {
    if (client) {
      if (
        'getService' in client &&
        typeof (client as ClientGrpc).getService === 'function'
      ) {
        try {
          this.inventoryService = (client as ClientGrpc).getService<InventoryGrpcService>(
            INVENTORY_SERVICE_NAME,
          );
        } catch {
          // May be deferred to onModuleInit
        }
      } else {
        this.inventoryService = client as InventoryGrpcService;
      }
    }
  }

  onModuleInit(): void {
    if (
      !this.inventoryService &&
      this.client &&
      'getService' in this.client &&
      typeof (this.client as ClientGrpc).getService === 'function'
    ) {
      this.inventoryService = (this.client as ClientGrpc).getService<InventoryGrpcService>(
        INVENTORY_SERVICE_NAME,
      );
    }
  }

  private async callHoldSeats(
    req: HoldSeatsRequest,
  ): Promise<HoldSeatsResponse> {
    const result = this.inventoryService.holdSeats(req);
    if (isObservable(result)) {
      return await firstValueFrom(result);
    }
    return await result;
  }

  private async callReleaseSeats(
    req: ReleaseSeatsRequest,
  ): Promise<ReleaseSeatsResponse> {
    const result = this.inventoryService.releaseSeats(req);
    if (isObservable(result)) {
      return await firstValueFrom(result);
    }
    return await result;
  }

  async createDraft(
    dto: CreateBookingDraftDto,
  ): Promise<BookingDraftResponse> {
    const groupSize = determinePassengerCount(dto);
    if (
      !groupSize ||
      groupSize < 1 ||
      groupSize > 4 ||
      !Number.isInteger(groupSize)
    ) {
      throw new BookingDraftError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid passenger count: ${groupSize}. Group size must be between 1 and 4.`,
      );
    }

    const legs: BookingDraftLegInput[] =
      Array.isArray(dto.legs) && dto.legs.length > 0
        ? dto.legs
        : dto.tripId && dto.travelClassId && dto.originStationId && dto.destinationStationId
        ? [
            {
              tripId: dto.tripId,
              travelClassId: dto.travelClassId,
              originStationId: dto.originStationId,
              destinationStationId: dto.destinationStationId,
            },
          ]
        : [];

    if (legs.length === 0) {
      throw new BookingDraftError(
        ErrorCode.VALIDATION_ERROR,
        'Booking draft requires at least one leg.',
      );
    }

    const draftId = randomUUID();
    const passengerNames = extractPassengerNames(dto, groupSize);
    const acquiredHolds: string[] = [];
    const completedLegs: BookingDraftLeg[] = [];

    try {
      for (const leg of legs) {
        const holdReq: HoldSeatsRequest = {
          tripId: leg.tripId,
          travelClassId: leg.travelClassId,
          originStationId: leg.originStationId,
          destinationStationId: leg.destinationStationId,
          groupSize,
          ttlSeconds: 600,
          bookingId: draftId,
        };

        const holdRes = await this.callHoldSeats(holdReq);
        acquiredHolds.push(holdRes.holdId);

        const legSeats = (holdRes.seats ?? []).map((seat, idx) => {
          const pName = passengerNames[idx] ?? 'Passenger';
          const base =
            seat.label ?? `Coach ${seat.coachNumber} · Seat ${seat.seatNumber}`;
          return `${pName} · ${base}`;
        });

        const isSplit =
          holdRes.allocationOutcome === AllocationOutcome.SPLIT;
        const splitNotice = isSplit
          ? holdRes.splitNotice ?? SEATS_SPLIT_NOTICE
          : undefined;

        completedLegs.push({
          holdId: holdRes.holdId,
          tripId: leg.tripId,
          travelClassId: leg.travelClassId,
          originStationId: leg.originStationId,
          destinationStationId: leg.destinationStationId,
          allocationOutcome: holdRes.allocationOutcome,
          seats: legSeats,
          assignedSeats: holdRes.seats,
          splitNotice,
          expiresAt: holdRes.expiresAt,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Draft ${draftId} failed during seat allocation; compensating ${acquiredHolds.length} hold(s)`,
      );

      for (const holdId of acquiredHolds) {
        try {
          await this.callReleaseSeats({ holdId });
        } catch (releaseError) {
          this.logger.error(
            `Failed to release hold ${holdId} during compensation: ${String(releaseError)}`,
          );
        }
      }

      try {
        const failedDraft = this.draftRepository.create({
          id: draftId,
          userId: dto.userId,
          status: 'FAILED',
          expiresAt: new Date(),
          legs: completedLegs,
          createdAt: new Date(),
        });
        await this.draftRepository.save(failedDraft);
      } catch (saveError) {
        this.logger.warn(
          `Failed to record failed draft ${draftId}: ${String(saveError)}`,
        );
      }

      const { code, message, availableCount } = extractErrorDetails(error);
      throw new BookingDraftError(code, message, availableCount);
    }

    const defaultExpiry = new Date(Date.now() + 600_000);
    const expiresAt = completedLegs.reduce<Date>((earliest, leg) => {
      if (!leg.expiresAt) return earliest;
      const legDate = new Date(leg.expiresAt);
      return legDate < earliest ? legDate : earliest;
    }, defaultExpiry);

    const draft = this.draftRepository.create({
      id: draftId,
      userId: dto.userId,
      status: 'PENDING',
      expiresAt,
      legs: completedLegs,
      createdAt: new Date(),
    });

    await this.draftRepository.save(draft);

    return {
      id: draft.id,
      userId: draft.userId,
      status: draft.status,
      expiresAt: draft.expiresAt,
      legs: draft.legs,
      createdAt: draft.createdAt,
    };
  }

  async getDraft(id: string): Promise<BookingDraftEntity | null> {
    return await this.draftRepository.findOne({ where: { id } });
  }
}
