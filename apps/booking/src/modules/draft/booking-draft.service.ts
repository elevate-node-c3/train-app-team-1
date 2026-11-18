import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { CallOptions, Metadata } from '@grpc/grpc-js';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, from, timeout, type Observable } from 'rxjs';
import { isUUID } from 'class-validator';
import {
  createGrpcMetadataWithCorrelation,
  resolveLanguage,
} from '@app/common';
import { matchesServiceCredential } from '@app/common/grpc/service-credential.js';
import {
  ErrorCode,
  IDENTITY_SERVICE_NAME,
  INVENTORY_SERVICE_NAME,
  type CreateHoldRequest,
  type GetHoldRequest,
  type HoldSnapshot,
  type ResolveHoldPassengersRequest,
  type ResolveHoldPassengersResponse,
  type ResolvedHoldPassenger,
} from '@app/contracts';
import {
  BookingDraftEntity,
  type BookingHoldIntent,
} from './entities/booking-draft.entity.js';
import type {
  BookingDraftResponse,
  CreateBookingDraftDto,
} from './dto/create-booking-draft.dto.js';
import {
  BookingDraftStore,
  projectHoldSnapshot,
} from './booking-draft.store.js';
import {
  BookingDraftError,
  extractErrorDetails,
  isMissingHold,
} from './booking-draft.errors.js';
import { isHoldInstant, isHoldOutcome } from './hold-lifecycle.parser.js';

export {
  BookingDraftError,
  extractErrorDetails,
} from './booking-draft.errors.js';
export const INVENTORY_GRPC_CLIENT = 'INVENTORY_GRPC_CLIENT';
export const IDENTITY_GRPC_CLIENT = 'BOOKING_IDENTITY_GRPC_CLIENT';
export const BOOKING_GRPC_TIMEOUT_MS = 2500;

type Unary<TRequest, TResponse> = (
  request: TRequest,
  metadata: Metadata,
  options: CallOptions,
) => Observable<TResponse> | Promise<TResponse>;

export interface InventoryGrpcService {
  createHold: Unary<CreateHoldRequest, HoldSnapshot>;
  getHold: Unary<GetHoldRequest, HoldSnapshot>;
  releaseHold: Unary<GetHoldRequest, HoldSnapshot>;
  extendHold: Unary<GetHoldRequest, HoldSnapshot>;
}

export interface BookingIdentityGrpcService {
  resolveHoldPassengers: Unary<
    ResolveHoldPassengersRequest,
    ResolveHoldPassengersResponse
  >;
}

@Injectable()
export class BookingDraftService implements OnModuleInit {
  private readonly logger = new Logger(BookingDraftService.name);
  private inventory!: InventoryGrpcService;
  private identity!: BookingIdentityGrpcService;

  constructor(
    private readonly store: BookingDraftStore,
    @Inject(INVENTORY_GRPC_CLIENT)
    private readonly inventoryClient: ClientGrpc | InventoryGrpcService,
    @Inject(IDENTITY_GRPC_CLIENT)
    private readonly identityClient: ClientGrpc | BookingIdentityGrpcService,
    private readonly cls: ClsService,
  ) {
    if (!('getService' in inventoryClient)) this.inventory = inventoryClient;
    if (!('getService' in identityClient)) this.identity = identityClient;
  }

  onModuleInit(): void {
    if ('getService' in this.inventoryClient) {
      this.inventory = this.inventoryClient.getService<InventoryGrpcService>(
        INVENTORY_SERVICE_NAME,
      );
    }
    if ('getService' in this.identityClient) {
      this.identity =
        this.identityClient.getService<BookingIdentityGrpcService>(
          IDENTITY_SERVICE_NAME,
        );
    }
  }

  async createDraft(
    dto: CreateBookingDraftDto,
    language?: string,
  ): Promise<BookingDraftResponse> {
    const { id, userId, intent, fingerprint } = normalizeBookingIntent(dto);
    let draft = await this.store.createIntent(id, userId, fingerprint, intent);
    if (draft.releaseRequested) return this.releaseHold(userId, id, language);
    if (draft.holdFailure) throw this.failureFor(draft.holdFailure, draft);

    if (!draft.passengerSnapshot) {
      try {
        const resolved = await this.rpc<
          ResolveHoldPassengersRequest,
          ResolveHoldPassengersResponse
        >(
          this.identity,
          'resolveHoldPassengers',
          {
            ownerId: userId,
            passengerRefs: intent.passengerRefs,
            tripIds: intent.legs.map((leg) => leg.tripId),
          },
          'identity',
          language,
        );
        // Concurrent resolvers may finish differently. Only the first persisted
        // snapshot wins; every CreateHold uses that same committed snapshot.
        draft = await this.store.rememberPassengers(
          id,
          userId,
          identitySnapshot(resolved, intent),
        );
      } catch (error) {
        const details = extractErrorDetails(error);
        if (!details.definite)
          throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
        draft = await this.store.rejectIntent(
          id,
          userId,
          { code: details.code },
          'identity',
        );
        if (draft.holdFailure) throw this.failureFor(draft.holdFailure, draft);
      }
    }

    const requested = await this.store.requestHold(id, userId);
    draft = requested.draft;
    if (draft.releaseRequested) return this.releaseHold(userId, id, language);
    if (draft.holdFailure) throw this.failureFor(draft.holdFailure, draft);
    if (!draft.passengerSnapshot)
      throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);

    try {
      if (requested.alreadyRequested || draft.holdId !== null) {
        try {
          return await this.readInventory(draft, language);
        } catch (error) {
          if (!isMissingHold(error) || draft.holdVersion > 0) throw error;
          // A timeout never creates a new key or a new identity snapshot.
        }
      }
      const snapshot = await this.rpc<CreateHoldRequest, HoldSnapshot>(
        this.inventory,
        'createHold',
        {
          ownerId: userId,
          bookingKey: id,
          legs: draft.holdIntent!.legs,
          passengers: draft.passengerSnapshot.map(
            ({ passengerRef, identities }) => ({ passengerRef, identities }),
          ),
        },
        'inventory',
        language,
      );
      const persisted = await this.rememberHold(draft, snapshot);
      if (persisted.releaseRequested && persisted.holdState === 'HELD') {
        return this.releaseHold(userId, id, language);
      }
      return responseFor(persisted);
    } catch (error) {
      const details = extractErrorDetails(error);
      if (details.definite) {
        draft = await this.store.rejectIntent(
          id,
          userId,
          {
            code: details.code,
            availableCount: details.availableCount,
            passengerRef: draft.passengerSnapshot.find(
              (p) => p.passengerRef === details.passengerRef,
            )?.passengerRef,
          },
          'inventory',
        );
        if (draft.holdFailure) throw this.failureFor(draft.holdFailure, draft);
        // An event/other replay may already prove a committed hold.
        return responseFor(draft);
      }
      try {
        return await this.readInventory(draft, language);
      } catch {
        // Allocation may have committed. Keep its durable intent and never
        // compensate a transport timeout; the same key recovers on retry/GET.
        return { ...responseFor(draft), reconciliationPending: true };
      }
    }
  }

  async getDraft(
    id: string,
    userId: string,
    language?: string,
  ): Promise<BookingDraftResponse | null> {
    assertOwnerKey(userId, id);
    const draft = await this.store.findOwned(
      id.toLowerCase(),
      userId.toLowerCase(),
    );
    if (!draft) return null;
    if (!draft.holdIntent) return responseFor(draft);
    if (
      draft.releaseRequested &&
      (draft.holdState === null || draft.holdState === 'HELD')
    ) {
      return this.releaseHold(userId, id, language);
    }
    if (draft.holdFailure) return responseFor(draft);
    if (!draft.holdRequested && !draft.holdId) return responseFor(draft);
    if (
      draft.holdState !== null &&
      draft.holdState !== 'HELD' &&
      !draft.reconciliationPending
    ) {
      return responseFor(draft);
    }
    try {
      return await this.readInventory(draft, language);
    } catch (error) {
      if (isMissingHold(error) && draft.holdState === null)
        return responseFor(draft);
      // Never claim a stale cached HELD state when Inventory cannot reconcile it.
      throw this.failureFor(error, draft);
    }
  }

  /** Private owner/key adapters. No HTTP release or 3DS extension route exists. */
  async getHold(
    ownerId: string,
    bookingKey: string,
    language?: string,
  ): Promise<BookingDraftResponse> {
    const draft = await this.getDraft(bookingKey, ownerId, language);
    if (!draft) throw new BookingDraftError(ErrorCode.HOLD_NOT_FOUND);
    return draft;
  }

  async releaseHold(
    ownerId: string,
    bookingKey: string,
    language?: string,
  ): Promise<BookingDraftResponse> {
    assertOwnerKey(ownerId, bookingKey);
    const draft = await this.store.requestRelease(
      bookingKey.toLowerCase(),
      ownerId.toLowerCase(),
    );
    try {
      const snapshot = await this.rpc<GetHoldRequest, HoldSnapshot>(
        this.inventory,
        'releaseHold',
        {
          ownerId: draft.userId,
          bookingKey: draft.id,
        },
        'inventory',
        language,
      );
      return responseFor(await this.rememberHold(draft, snapshot));
    } catch (error) {
      if (extractErrorDetails(error).definite)
        throw this.failureFor(error, draft);
      return { ...responseFor(draft), reconciliationPending: true };
    }
  }

  /** PAY-2 will invoke this only after an authenticated 3DS challenge begins. */
  async extendHold(
    ownerId: string,
    bookingKey: string,
    language?: string,
  ): Promise<BookingDraftResponse> {
    assertOwnerKey(ownerId, bookingKey);
    const draft = await this.store.findOwned(
      bookingKey.toLowerCase(),
      ownerId.toLowerCase(),
    );
    if (!draft || !draft.holdIntent)
      throw new BookingDraftError(ErrorCode.HOLD_NOT_FOUND);
    if (draft.releaseRequested)
      throw new BookingDraftError(ErrorCode.HOLD_TERMINAL);
    try {
      const snapshot = await this.rpc<GetHoldRequest, HoldSnapshot>(
        this.inventory,
        'extendHold',
        {
          ownerId: draft.userId,
          bookingKey: draft.id,
        },
        'inventory',
        language,
      );
      return responseFor(await this.rememberHold(draft, snapshot));
    } catch (error) {
      throw this.failureFor(error, draft);
    }
  }

  /** Event handlers call only GET after committing their local version fence. */
  async reconcileHold(ownerId: string, bookingKey: string): Promise<void> {
    const draft = await this.store.findOwned(bookingKey, ownerId);
    if (!draft || !draft.reconciliationPending) return;
    try {
      const response = await this.readInventory(draft, undefined, false);
      if (response.holdState === 'HELD' && response.reconciliationPending) {
        throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
      }
    } catch {
      throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
  }

  private async readInventory(
    draft: BookingDraftEntity,
    language?: string,
    allowDeferredSave = true,
  ): Promise<BookingDraftResponse> {
    const snapshot = await this.rpc<GetHoldRequest, HoldSnapshot>(
      this.inventory,
      'getHold',
      {
        ownerId: draft.userId,
        bookingKey: draft.id,
      },
      'inventory',
      language,
    );
    return responseFor(
      await this.rememberHold(draft, snapshot, allowDeferredSave),
    );
  }

  private async rememberHold(
    draft: BookingDraftEntity,
    value: HoldSnapshot,
    allowDeferredSave = true,
  ): Promise<BookingDraftEntity> {
    const snapshot = holdSnapshot(value, draft);
    try {
      return await this.store.applySnapshot(snapshot);
    } catch {
      if (!allowDeferredSave)
        throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
      // A durable pre-RPC intent already exists. Return the known receipt rather
      // than a misleading 500; retries and lifecycle delivery repair the save.
      this.logger.warn(
        'Hold receipt save deferred; durable booking intent retained.',
      );
      const fallback = structuredClone(draft);
      projectHoldSnapshot(fallback, snapshot);
      fallback.reconciliationPending = true;
      return fallback;
    }
  }

  private failureFor(
    error: unknown,
    draft: BookingDraftEntity,
  ): BookingDraftError {
    const details = extractErrorDetails(error);
    const passenger = draft.passengerSnapshot?.find(
      (p) => p.passengerRef === details.passengerRef,
    );
    return new BookingDraftError(
      details.code,
      undefined,
      details.availableCount,
      passenger?.passengerRef,
      passenger?.maskedNationalId,
    );
  }

  private async rpc<TRequest extends { ownerId: string }, TResponse>(
    service: object,
    method: string,
    request: TRequest,
    target: 'inventory' | 'identity',
    language?: string,
  ): Promise<TResponse> {
    const secret =
      target === 'inventory'
        ? process.env.BOOKING_INVENTORY_SERVICE_KEY
        : process.env.BOOKING_IDENTITY_SERVICE_KEY;
    if (!matchesServiceCredential(secret, secret))
      throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
    const metadata = createGrpcMetadataWithCorrelation(this.cls);
    metadata.set(`x-booking-${target}-key`, secret!);
    metadata.set('x-caller-account-id', request.ownerId);
    metadata.set('accept-language', resolveLanguage(language));
    const invoke = (service as Record<string, Unary<TRequest, TResponse>>)?.[
      method
    ];
    if (!invoke) throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
    return firstValueFrom(
      from(
        invoke.call(service, request, metadata, {
          deadline: Date.now() + BOOKING_GRPC_TIMEOUT_MS,
        }),
      ).pipe(timeout({ first: BOOKING_GRPC_TIMEOUT_MS })),
    );
  }
}

function assertOwnerKey(ownerId: string, bookingKey: string): void {
  if (
    typeof ownerId !== 'string' ||
    !isUUID(ownerId) ||
    typeof bookingKey !== 'string' ||
    !isUUID(bookingKey)
  ) {
    throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
  }
}

export function normalizeBookingIntent(dto: CreateBookingDraftDto): {
  id: string;
  userId: string;
  intent: BookingHoldIntent;
  fingerprint: string;
} {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto))
    throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
  assertOwnerKey(dto.userId, dto.bookingKey);
  const allowed = new Set([
    'bookingKey',
    'userId',
    'passengerIds',
    'legs',
    'tripId',
    'travelClassId',
    'originStationId',
    'destinationStationId',
  ]);
  if (
    Object.keys(dto).some((key) => !allowed.has(key)) ||
    !Array.isArray(dto.passengerIds) ||
    dto.passengerIds.length < 1 ||
    dto.passengerIds.length > 4 ||
    dto.passengerIds.some((id) => typeof id !== 'string' || !isUUID(id))
  ) {
    throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
  }
  const passengerRefs = dto.passengerIds.map((id) => id.toLowerCase());
  const direct = [
    'tripId',
    'travelClassId',
    'originStationId',
    'destinationStationId',
  ] as const;
  if (dto.legs !== undefined && direct.some((key) => dto[key] !== undefined)) {
    throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
  }
  const input = dto.legs ?? [
    {
      tripId: dto.tripId,
      travelClassId: dto.travelClassId,
      originStationId: dto.originStationId,
      destinationStationId: dto.destinationStationId,
    },
  ];
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 2 ||
    new Set(passengerRefs).size !== passengerRefs.length
  )
    throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
  const legs = input.map((leg) => {
    if (
      !leg ||
      typeof leg !== 'object' ||
      Object.keys(leg).some(
        (key) => !direct.includes(key as (typeof direct)[number]),
      ) ||
      direct.some((key) => typeof leg[key] !== 'string' || !isUUID(leg[key]!))
    ) {
      throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
    }
    return {
      tripId: leg.tripId!.toLowerCase(),
      travelClassId: leg.travelClassId!.toLowerCase(),
      originStationId: leg.originStationId!.toLowerCase(),
      destinationStationId: leg.destinationStationId!.toLowerCase(),
    };
  });
  if (new Set(legs.map((leg) => leg.tripId)).size !== legs.length)
    throw new BookingDraftError(ErrorCode.VALIDATION_ERROR);
  const intent = { legs, passengerRefs };
  const userId = dto.userId.toLowerCase();
  return {
    id: dto.bookingKey.toLowerCase(),
    userId,
    intent,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ userId, ...intent }))
      .digest('hex'),
  };
}

function identitySnapshot(
  value: ResolveHoldPassengersResponse,
  intent: BookingHoldIntent,
): ResolvedHoldPassenger[] {
  const invalid = (): never => {
    throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
  };
  if (
    !value ||
    !Array.isArray(value.passengers) ||
    value.passengers.length !== intent.passengerRefs.length
  )
    invalid();
  return intent.passengerRefs.map((ref) => {
    const matches = value.passengers.filter(
      (passenger) => passenger.passengerRef === ref,
    );
    if (matches.length !== 1) invalid();
    const passenger = matches[0];
    if (
      typeof passenger.displayName !== 'string' ||
      !passenger.displayName.trim() ||
      passenger.displayName.length > 50 ||
      typeof passenger.maskedNationalId !== 'string' ||
      !/^\*{10}[0-9]{4}$/.test(passenger.maskedNationalId) ||
      !Array.isArray(passenger.identities) ||
      passenger.identities.length !== intent.legs.length
    )
      invalid();
    return {
      passengerRef: ref,
      displayName: passenger.displayName,
      maskedNationalId: passenger.maskedNationalId,
      identities: intent.legs.map((leg) => {
        const identities = passenger.identities.filter(
          (identity) => identity.tripId === leg.tripId,
        );
        if (identities.length !== 1) invalid();
        const identity = identities[0];
        if (
          typeof identity.passengerToken !== 'string' ||
          !/^[a-f0-9]{64}$/.test(identity.passengerToken) ||
          !Number.isSafeInteger(identity.passengerKeyVersion) ||
          identity.passengerKeyVersion < 1
        )
          invalid();
        return {
          tripId: leg.tripId,
          passengerToken: identity.passengerToken,
          passengerKeyVersion: identity.passengerKeyVersion,
        };
      }),
    };
  });
}

function holdSnapshot(
  value: HoldSnapshot,
  draft: BookingDraftEntity,
): HoldSnapshot {
  const invalid = (): never => {
    throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
  };
  if (
    !value ||
    value.bookingKey !== draft.id ||
    value.ownerId !== draft.userId ||
    typeof value.holdId !== 'string' ||
    !isUUID(value.holdId) ||
    !['HELD', 'RELEASED', 'EXPIRED', 'CANCELLED'].includes(value.state) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.extensionUsed !== 'boolean' ||
    !isHoldInstant(value.serverNow) ||
    !Array.isArray(value.legs) ||
    !Array.isArray(value.assignments)
  )
    invalid();
  const expiresAt = value.expiresAt === '' ? null : value.expiresAt;
  if (value.state === 'CANCELLED') {
    if (expiresAt !== null || value.legs.length || value.assignments.length)
      invalid();
    return {
      holdId: value.holdId,
      bookingKey: draft.id,
      ownerId: draft.userId,
      state: value.state,
      version: value.version,
      extensionUsed: value.extensionUsed,
      expiresAt: null,
      serverNow: value.serverNow,
      allocationOutcome: null,
      legs: [],
      assignments: [],
    };
  }
  if (
    !isHoldInstant(expiresAt) ||
    !isHoldOutcome(value.allocationOutcome) ||
    !draft.holdIntent ||
    !draft.passengerSnapshot ||
    value.legs.length !== draft.holdIntent.legs.length ||
    value.assignments.length !==
      draft.holdIntent.legs.length * draft.passengerSnapshot.length
  )
    invalid();
  const legs = draft.holdIntent!.legs.map((input) => {
    const matches = value.legs.filter((leg) => leg.tripId === input.tripId);
    if (matches.length !== 1) invalid();
    const leg = matches[0];
    if (
      leg.travelClassId !== input.travelClassId ||
      leg.originStationId !== input.originStationId ||
      leg.destinationStationId !== input.destinationStationId ||
      !isHoldOutcome(leg.outcome) ||
      !Number.isSafeInteger(leg.originPosition) ||
      !Number.isSafeInteger(leg.destinationPosition) ||
      leg.originPosition < 0 ||
      leg.destinationPosition <= leg.originPosition
    )
      invalid();
    return {
      ...input,
      originPosition: leg.originPosition,
      destinationPosition: leg.destinationPosition,
      outcome: leg.outcome,
    };
  });
  const assignments = legs.flatMap((leg) =>
    draft.passengerSnapshot!.map((passenger) => {
      const matches = value.assignments.filter(
        (assignment) =>
          assignment.tripId === leg.tripId &&
          assignment.passengerRef === passenger.passengerRef,
      );
      if (matches.length !== 1) invalid();
      const seat = matches[0];
      const identity = passenger.identities.find(
        (candidate) => candidate.tripId === leg.tripId,
      )!;
      if (
        seat.passengerKeyVersion !== identity.passengerKeyVersion ||
        !isUUID(seat.tripSeatId) ||
        seat.travelClassId !== leg.travelClassId ||
        seat.originStationId !== leg.originStationId ||
        seat.destinationStationId !== leg.destinationStationId ||
        seat.originPosition !== leg.originPosition ||
        seat.destinationPosition !== leg.destinationPosition ||
        seat.outcome !== leg.outcome ||
        !Number.isSafeInteger(seat.coachNumber) ||
        !Number.isSafeInteger(seat.rowNumber) ||
        typeof seat.seatNumber !== 'string' ||
        !seat.seatNumber ||
        (seat.label !== undefined && typeof seat.label !== 'string')
      )
        invalid();
      return {
        ...leg,
        passengerRef: passenger.passengerRef,
        passengerKeyVersion: identity.passengerKeyVersion,
        tripSeatId: seat.tripSeatId,
        coachNumber: seat.coachNumber,
        seatNumber: seat.seatNumber,
        rowNumber: seat.rowNumber,
        ...(seat.label ? { label: seat.label } : {}),
      };
    }),
  );
  return {
    holdId: value.holdId,
    bookingKey: draft.id,
    ownerId: draft.userId,
    state: value.state,
    version: value.version,
    extensionUsed: value.extensionUsed,
    expiresAt,
    serverNow: value.serverNow,
    allocationOutcome: value.allocationOutcome,
    legs,
    assignments,
  };
}

function responseFor(draft: BookingDraftEntity): BookingDraftResponse {
  return {
    id: draft.id,
    userId: draft.userId,
    status: draft.status,
    expiresAt: draft.expiresAt,
    legs: draft.legs,
    createdAt: draft.createdAt,
    holdId: draft.holdId,
    holdState: draft.holdState,
    holdVersion: draft.holdVersion,
    serverNow: draft.holdServerNow,
    extensionUsed: draft.extensionUsed,
    reconciliationPending: draft.reconciliationPending,
  };
}
