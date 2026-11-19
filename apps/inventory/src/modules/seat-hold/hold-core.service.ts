import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AllocationOutcome,
  ErrorCode,
  type CreateHoldRequest,
  type ExtendHoldRequest,
  type GetHoldRequest,
  type HoldLegInput,
  type HoldLifecyclePayloadV1,
  type HoldPassengerInput,
  type HoldSnapshot,
  type ReleaseHoldRequest,
} from '@app/contracts';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { isUUID } from 'class-validator';

import {
  calculateHoldExpiry,
  calculateHoldExtension,
  HoldExpiryError,
} from './hold-expiry.policy.js';
import { HoldCoreError } from './hold-core.errors.js';
import {
  HoldCoreRepository,
  type HoldRow,
  type LegFacts,
  type PersistedAssignment,
  type PersistedLeg,
} from './hold-core.repository.js';
import { buildHoldEvent } from './hold-events.factory.js';
import { allocateGroupSeats } from '../seat-allocation/seat-allocator.js';
import type { AllocationResult } from '../seat-allocation/seat-allocator.types.js';
import {
  MAX_BOOKING_KEY_LENGTH,
  MAX_LEGS,
  MAX_PASSENGER_REF_LENGTH,
  MAX_PASSENGER_TOKEN_LENGTH,
  MAX_PASSENGERS,
} from './seat-hold.limits.js';

const MAX_ATTEMPTS = 3;

type TerminationReason = 'released' | 'expired' | 'replaced';

interface ExtendTransactionResult {
  terminal: boolean;
  snapshot: HoldSnapshot;
}

/**
 * MT-17 through MT-20: one transaction creates, replaces, releases, or extends
 * a complete multi-passenger/multi-leg hold. All seat facts, departure times,
 * and the clock come from Postgres; the client supplies only identifiers.
 */
@Injectable()
export class HoldCoreService {
  private readonly logger = new Logger(HoldCoreService.name);

  constructor(
    private readonly repository: HoldCoreRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  /** A whole batch commits its releases and durable events together. */
  async expireDueHolds(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        'An expiry batch must contain between one and 1000 holds.',
      );
    }

    return this.runInTransaction(async (ctx) => {
      const holds = await this.repository.lockDueHolds(ctx, limit);
      if (holds.length === 0) return 0;

      const holdIds = holds.map((hold) => hold.id);
      // Use the same hold-before-trip and sorted-trip order as request paths.
      await this.repository.lockTrips(
        ctx,
        await this.repository.tripIdsForHolds(ctx, holdIds),
      );
      const now = await this.repository.sampleNow(ctx);
      const payloads = await this.repository.expireHolds(ctx, holdIds, now);
      const correlationId = randomUUID();

      await this.outbox.appendBatch(
        ctx,
        payloads.map((payload) =>
          buildHoldEvent({
            eventId: randomUUID(),
            correlationId,
            occurredAt: now,
            payload,
          }),
        ),
      );
      return payloads.length;
    });
  }

  async createHold(
    request: CreateHoldRequest,
    correlationId: string = randomUUID(),
  ): Promise<HoldSnapshot> {
    this.validateCreate(request);
    const fingerprint = fingerprintOf(request);

    return this.runInTransaction(async (ctx) => {
      const existing = await this.repository.lockHoldByKey(
        ctx,
        request.bookingKey,
      );
      if (existing) {
        return this.replayOrRefuse(
          ctx,
          existing,
          request,
          fingerprint,
          correlationId,
        );
      }

      // Serialize same-owner creates before reading the active hold. Without
      // this guard, a second session can miss the winner's uncommitted hold,
      // wait on the trip lock, then misread its committed occupation as an
      // identity conflict instead of replacing it.
      await this.repository.lockOwnerGuard(ctx, request.ownerId);

      const ownerHold = await this.repository.lockActiveHoldByOwner(
        ctx,
        request.ownerId,
      );
      const oldTripIds = ownerHold
        ? await this.repository.legTripIds(ctx, ownerHold.id)
        : [];

      // Globally sorted union of the previous and new trips. This is the
      // common lock order for create, replacement, release, and extension.
      await this.repository.lockTrips(ctx, [
        ...oldTripIds,
        ...request.legs.map((leg) => leg.tripId),
      ]);

      // Sample only after every lock wait: a hold must not promise time that
      // was already consumed while it waited.
      const now = await this.repository.sampleNow(ctx);

      if (ownerHold) {
        await this.terminateHold(
          ctx,
          ownerHold,
          now,
          this.isDue(ownerHold, now) ? 'expired' : 'replaced',
          correlationId,
        );
      }

      const targetTripIds = request.legs.map((leg) => leg.tripId);
      await this.repository.reclaimExpiredOccupations(ctx, targetTripIds, now);

      const facts = await this.repository.resolveLegFacts(ctx, request.legs);
      const expiresAt = this.expiryFor(facts, now);

      // Passenger overlap is checked before shortage so the caller receives
      // the specific identity refusal, not a misleading seat count.
      await this.repository.assertPassengersClear(
        ctx,
        request.passengers,
        facts,
        now,
      );

      const allocations = await this.allocateEveryLeg(
        ctx,
        request.passengers,
        facts,
        now,
      );

      const holdId = randomUUID();
      const legs: PersistedLeg[] = allocations.map((allocation) => ({
        tripId: allocation.facts.leg.tripId,
        travelClassId: allocation.facts.leg.travelClassId,
        originStationId: allocation.facts.leg.originStationId,
        destinationStationId: allocation.facts.leg.destinationStationId,
        originPosition: allocation.facts.originPosition,
        destinationPosition: allocation.facts.destinationPosition,
        segment: allocation.facts.segment,
        outcome: allocation.outcome,
      }));
      const assignments = allocations.flatMap(
        (allocation) => allocation.assignments,
      );

      await this.repository.insertHold(ctx, {
        id: holdId,
        bookingKey: request.bookingKey,
        ownerId: request.ownerId,
        fingerprint,
        expiresAt,
        now,
        passengers: request.passengers,
        legs,
        assignments,
      });

      const snapshot = await this.repository.loadSnapshot(ctx, holdId, now);
      await this.appendEvent(ctx, snapshot, 'held', correlationId, now);
      return snapshot;
    });
  }

  async getHold(
    request: GetHoldRequest,
    correlationId: string = randomUUID(),
  ): Promise<HoldSnapshot> {
    this.validateKeyRequest(request);

    return this.runInTransaction(async (ctx) => {
      const hold = await this.repository.lockHoldByKey(ctx, request.bookingKey);
      if (!hold) {
        throw new HoldCoreError(
          ErrorCode.HOLD_NOT_FOUND,
          'No hold exists for this booking key.',
        );
      }
      this.assertOwner(hold, request.ownerId);

      const now = await this.repository.sampleNow(ctx);
      if (this.isDue(hold, now)) {
        await this.terminateHold(ctx, hold, now, 'expired', correlationId);
      }

      return this.repository.loadSnapshot(ctx, hold.id, now);
    });
  }

  async releaseHold(
    request: ReleaseHoldRequest,
    correlationId: string = randomUUID(),
  ): Promise<HoldSnapshot> {
    this.validateKeyRequest(request);

    return this.runInTransaction(async (ctx) => {
      const existing = await this.repository.lockHoldByKey(
        ctx,
        request.bookingKey,
      );
      const now = await this.repository.sampleNow(ctx);

      if (!existing) {
        // A release may arrive before a timed-out create. The tombstone
        // fences the key so the late create cannot orphan ownership.
        await this.repository.insertCancellationTombstone(ctx, {
          id: randomUUID(),
          bookingKey: request.bookingKey,
          ownerId: request.ownerId,
          fingerprint: releaseFingerprint(request.ownerId),
          now,
        });

        const tombstone = await this.repository.lockHoldByKey(
          ctx,
          request.bookingKey,
        );
        if (!tombstone) {
          throw new HoldCoreError(
            ErrorCode.INTERNAL_SERVER_ERROR,
            'The cancellation tombstone could not be read back.',
          );
        }
        this.assertOwner(tombstone, request.ownerId);
        // A concurrent create may win the insert. Release that committed hold
        // instead of returning its live receipt as if cancellation had won.
        const resolvedNow = await this.repository.sampleNow(ctx);
        if (tombstone.state === 'held') {
          await this.terminateHold(
            ctx,
            tombstone,
            resolvedNow,
            this.isDue(tombstone, resolvedNow) ? 'expired' : 'released',
            correlationId,
          );
        }
        return this.repository.loadSnapshot(ctx, tombstone.id, resolvedNow);
      }

      this.assertOwner(existing, request.ownerId);

      if (existing.state === 'held') {
        const reason: TerminationReason = this.isDue(existing, now)
          ? 'expired'
          : 'released';
        await this.terminateHold(ctx, existing, now, reason, correlationId);
      }

      return this.repository.loadSnapshot(ctx, existing.id, now);
    });
  }

  async extendHold(
    request: ExtendHoldRequest,
    correlationId: string = randomUUID(),
  ): Promise<HoldSnapshot> {
    this.validateKeyRequest(request);

    const result = await this.runInTransaction<ExtendTransactionResult>(
      async (ctx) => {
        const hold = await this.repository.lockHoldByKey(
          ctx,
          request.bookingKey,
        );
        if (!hold) {
          throw new HoldCoreError(
            ErrorCode.HOLD_NOT_FOUND,
            'No hold exists for this booking key.',
          );
        }
        this.assertOwner(hold, request.ownerId);

        const initialNow = await this.repository.sampleNow(ctx);

        if (hold.state !== 'held') {
          return {
            terminal: true,
            snapshot: await this.repository.loadSnapshot(
              ctx,
              hold.id,
              initialNow,
            ),
          };
        }

        if (this.isDue(hold, initialNow)) {
          await this.terminateHold(
            ctx,
            hold,
            initialNow,
            'expired',
            correlationId,
          );
          return {
            terminal: true,
            snapshot: await this.repository.loadSnapshot(
              ctx,
              hold.id,
              initialNow,
            ),
          };
        }

        if (hold.extensionUsed) {
          throw new HoldCoreError(
            ErrorCode.EXTENSION_NOT_ALLOWED,
            'This hold has already used its one extension.',
          );
        }

        if (!hold.expiresAt) {
          throw new HoldCoreError(
            ErrorCode.INTERNAL_SERVER_ERROR,
            'An active hold is missing its promised expiry.',
          );
        }

        await this.repository.lockTrips(
          ctx,
          await this.repository.legTripIds(ctx, hold.id),
        );

        // Re-sample after the trip locks: a wait must not consume extension
        // time that was already gone when the lock was granted.
        const now = await this.repository.sampleNow(ctx);
        if (this.isDue(hold, now)) {
          await this.terminateHold(ctx, hold, now, 'expired', correlationId);
          return {
            terminal: true,
            snapshot: await this.repository.loadSnapshot(ctx, hold.id, now),
          };
        }

        const facts = await this.repository.resolveLegFacts(
          ctx,
          await this.repository.loadLegInputs(ctx, hold.id),
        );

        let extendedAt: Date | null;
        try {
          extendedAt = calculateHoldExtension({
            now,
            expiresAt: hold.expiresAt,
            originDepartureTimes: facts.map((fact) => fact.originDepartureAt),
          });
        } catch (error) {
          throw mapExpiryError(error);
        }

        if (extendedAt === null) {
          throw new HoldCoreError(
            ErrorCode.EXTENSION_NOT_ALLOWED,
            'The hold already ends at its current sales cutoff.',
          );
        }

        const applied = await this.repository.applyExtension(
          ctx,
          hold.id,
          extendedAt,
          hold.version + 1,
          now,
        );
        if (!applied) {
          throw new HoldCoreError(
            ErrorCode.EXTENSION_NOT_ALLOWED,
            'This hold has already used its one extension.',
          );
        }

        const snapshot = await this.repository.loadSnapshot(ctx, hold.id, now);
        await this.appendEvent(ctx, snapshot, 'extended', correlationId, now);
        return { terminal: false, snapshot };
      },
    );

    if (result.terminal) {
      throw new HoldCoreError(
        ErrorCode.HOLD_TERMINAL,
        'This hold is no longer active and cannot be extended.',
      );
    }

    return result.snapshot;
  }

  private async replayOrRefuse(
    ctx: TransactionContext,
    existing: HoldRow,
    request: CreateHoldRequest,
    fingerprint: string,
    correlationId: string,
  ): Promise<HoldSnapshot> {
    this.assertOwner(existing, request.ownerId);

    const now = await this.repository.sampleNow(ctx);

    // A tombstone deliberately ignores the create fingerprint: release won
    // the race, so the late create must not allocate anything.
    if (existing.state === 'cancelled') {
      return this.repository.loadSnapshot(ctx, existing.id, now);
    }

    if (existing.requestFingerprint !== fingerprint) {
      throw new HoldCoreError(
        ErrorCode.BOOKING_KEY_CONFLICT,
        'This booking key was already used for a different request.',
      );
    }

    if (this.isDue(existing, now)) {
      await this.terminateHold(ctx, existing, now, 'expired', correlationId);
    }

    return this.repository.loadSnapshot(ctx, existing.id, now);
  }

  private async terminateHold(
    ctx: TransactionContext,
    hold: HoldRow,
    now: Date,
    reason: TerminationReason,
    correlationId: string,
  ): Promise<void> {
    if (hold.state !== 'held') return;

    await this.repository.lockTrips(
      ctx,
      await this.repository.legTripIds(ctx, hold.id),
    );

    const nextState = reason === 'expired' ? 'expired' : 'released';
    const transitioned = await this.repository.markTerminal(
      ctx,
      hold.id,
      nextState,
      hold.version + 1,
      now,
    );
    if (!transitioned) return;

    await this.repository.releaseOccupations(ctx, hold.id, now);

    const snapshot = await this.repository.loadSnapshot(ctx, hold.id, now);
    await this.appendEvent(ctx, snapshot, reason, correlationId, now);
  }

  private async allocateEveryLeg(
    ctx: TransactionContext,
    passengers: readonly HoldPassengerInput[],
    facts: readonly LegFacts[],
    now: Date,
  ): Promise<
    {
      facts: LegFacts;
      outcome: AllocationOutcome;
      assignments: PersistedAssignment[];
    }[]
  > {
    const passengerByRef = new Map(
      passengers.map((passenger) => [passenger.passengerRef, passenger]),
    );
    const passengerIds = passengers.map((passenger) => passenger.passengerRef);
    const allocations: {
      facts: LegFacts;
      outcome: AllocationOutcome;
      assignments: PersistedAssignment[];
    }[] = [];

    for (const fact of facts) {
      const layout = await this.repository.layoutFor(ctx, fact, now);
      if (layout.seats.length === 0) {
        throw new HoldCoreError(
          ErrorCode.RESOURCE_NOT_FOUND,
          'The requested travel class is not offered on this trip.',
        );
      }

      const result: AllocationResult = allocateGroupSeats({
        groupSize: passengers.length,
        seats: layout.seats,
        occupiedSeatIds: layout.occupiedSeatIds,
        passengerIds,
      });

      if (!result.success) {
        if (result.availableCount === 0) {
          throw new HoldCoreError(
            ErrorCode.SEAT_TAKEN,
            'No seat is left for this leg.',
            0,
          );
        }
        throw new HoldCoreError(
          ErrorCode.INSUFFICIENT_SEATS,
          'Not enough seats are left for this leg.',
          result.availableCount,
        );
      }

      if (result.seats.length !== passengers.length) {
        throw new HoldCoreError(
          ErrorCode.INTERNAL_SERVER_ERROR,
          'The allocator returned an incomplete assignment.',
        );
      }

      const assignments: PersistedAssignment[] = result.seats.map(
        (seat, index) => {
          const passengerRef =
            seat.passengerId ?? passengers[index].passengerRef;
          const passenger = passengerByRef.get(passengerRef);
          if (!passenger) {
            throw new HoldCoreError(
              ErrorCode.INTERNAL_SERVER_ERROR,
              'The allocator returned an unknown passenger reference.',
            );
          }

          const identity = passenger.identities.find(
            (candidate) => candidate.tripId === fact.leg.tripId,
          );
          if (!identity) {
            throw new HoldCoreError(
              ErrorCode.INTERNAL_SERVER_ERROR,
              'A passenger is missing an identity for one hold leg.',
            );
          }

          return {
            passengerRef,
            passengerKeyVersion: identity.passengerKeyVersion,
            tripId: fact.leg.tripId,
            tripSeatId: seat.seatId,
            travelClassId: fact.leg.travelClassId,
            coachNumber: seat.coachNumber,
            seatNumber: seat.seatNumber,
            rowNumber: seat.rowNumber,
            ...(seat.label === undefined ? {} : { label: seat.label }),
            outcome: result.outcome,
            originStationId: fact.leg.originStationId,
            destinationStationId: fact.leg.destinationStationId,
            originPosition: fact.originPosition,
            destinationPosition: fact.destinationPosition,
            segment: fact.segment,
          };
        },
      );

      allocations.push({
        facts: fact,
        outcome: result.outcome,
        assignments,
      });
    }

    return allocations;
  }

  private expiryFor(facts: readonly LegFacts[], now: Date): Date {
    try {
      return calculateHoldExpiry({
        now,
        originDepartureTimes: facts.map((fact) => fact.originDepartureAt),
      });
    } catch (error) {
      throw mapExpiryError(error);
    }
  }

  private async appendEvent(
    ctx: TransactionContext,
    snapshot: HoldSnapshot,
    reason: 'held' | 'released' | 'expired' | 'replaced' | 'extended',
    correlationId: string,
    occurredAt: Date,
  ): Promise<void> {
    const payload: HoldLifecyclePayloadV1 = {
      holdId: snapshot.holdId,
      bookingKey: snapshot.bookingKey,
      ownerId: snapshot.ownerId,
      aggregateVersion: snapshot.version,
      state: snapshot.state,
      allocationOutcome: snapshot.allocationOutcome,
      legs: snapshot.legs.map((leg) => ({
        tripId: leg.tripId,
        travelClassId: leg.travelClassId,
        originStationId: leg.originStationId,
        destinationStationId: leg.destinationStationId,
        originPosition: leg.originPosition,
        destinationPosition: leg.destinationPosition,
        outcome: leg.outcome,
      })),
      expiresAt: snapshot.expiresAt,
      extensionUsed: snapshot.extensionUsed,
      reason,
    };

    await this.outbox.append(
      ctx,
      buildHoldEvent({
        eventId: randomUUID(),
        correlationId,
        occurredAt,
        payload,
      }),
    );
  }

  private isDue(hold: HoldRow, now: Date): boolean {
    return (
      hold.state === 'held' &&
      hold.expiresAt !== null &&
      hold.expiresAt.getTime() <= now.getTime()
    );
  }

  private assertOwner(hold: HoldRow, ownerId: string): void {
    if (hold.ownerId !== ownerId) {
      // Same refusal for a wrong owner and a changed payload: never reveal
      // that another traveller's key exists.
      throw new HoldCoreError(
        ErrorCode.BOOKING_KEY_CONFLICT,
        'This booking key does not belong to the requesting traveller.',
      );
    }
  }

  private validateCreate(request: CreateHoldRequest): void {
    this.validateKeyRequest(request);

    if (
      !Array.isArray(request.legs) ||
      request.legs.length < 1 ||
      request.legs.length > MAX_LEGS
    ) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        `A hold requires one to ${MAX_LEGS} legs.`,
      );
    }

    if (
      !Array.isArray(request.passengers) ||
      request.passengers.length < 1 ||
      request.passengers.length > MAX_PASSENGERS
    ) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        `A hold requires one to ${MAX_PASSENGERS} passengers.`,
      );
    }

    const tripIds = new Set<string>();
    for (const leg of request.legs) {
      this.validateLeg(leg);
      if (tripIds.has(leg.tripId)) {
        throw new HoldCoreError(
          ErrorCode.VALIDATION_ERROR,
          'A hold may contain only one leg per trip.',
        );
      }
      tripIds.add(leg.tripId);
    }

    const passengerRefs = new Set<string>();
    const passengerTokensByTrip = new Map<string, Set<string>>();
    for (const passenger of request.passengers) {
      this.validatePassenger(passenger, tripIds);
      if (passengerRefs.has(passenger.passengerRef)) {
        throw new HoldCoreError(
          ErrorCode.VALIDATION_ERROR,
          'Passenger references must be unique within a hold.',
        );
      }

      for (const identity of passenger.identities) {
        let tokens = passengerTokensByTrip.get(identity.tripId);
        if (!tokens) {
          tokens = new Set();
          passengerTokensByTrip.set(identity.tripId, tokens);
        }
        if (tokens.has(identity.passengerToken)) {
          throw new HoldCoreError(
            ErrorCode.PASSENGER_OVERLAP,
            'The same passenger cannot appear twice in one hold.',
            undefined,
            passenger.passengerRef,
          );
        }
        tokens.add(identity.passengerToken);
      }

      passengerRefs.add(passenger.passengerRef);
    }
  }

  private validateKeyRequest(request: {
    ownerId: string;
    bookingKey: string;
  }): void {
    if (!isUUID(request.ownerId)) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        'ownerId must be an identity account UUID.',
      );
    }

    if (
      typeof request.bookingKey !== 'string' ||
      request.bookingKey.length === 0 ||
      request.bookingKey.length > MAX_BOOKING_KEY_LENGTH
    ) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        'bookingKey must be a non-empty immutable key.',
      );
    }
  }

  private validateLeg(leg: HoldLegInput): void {
    const ids = [
      leg.tripId,
      leg.travelClassId,
      leg.originStationId,
      leg.destinationStationId,
    ];
    if (!ids.every((id) => isUUID(id))) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        'Leg ids must be UUIDs.',
      );
    }
  }

  private validatePassenger(
    passenger: HoldPassengerInput,
    tripIds: ReadonlySet<string>,
  ): void {
    if (
      typeof passenger.passengerRef !== 'string' ||
      passenger.passengerRef.length === 0 ||
      passenger.passengerRef.length > MAX_PASSENGER_REF_LENGTH
    ) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        'passengerRef must be a non-empty opaque reference.',
      );
    }

    if (
      !Array.isArray(passenger.identities) ||
      passenger.identities.length !== tripIds.size
    ) {
      throw new HoldCoreError(
        ErrorCode.VALIDATION_ERROR,
        'Each passenger requires exactly one identity per hold leg.',
      );
    }

    const seenTrips = new Set<string>();
    for (const identity of passenger.identities) {
      if (!tripIds.has(identity.tripId) || seenTrips.has(identity.tripId)) {
        throw new HoldCoreError(
          ErrorCode.VALIDATION_ERROR,
          'Passenger identities must match the hold legs exactly.',
        );
      }
      seenTrips.add(identity.tripId);

      if (
        typeof identity.passengerToken !== 'string' ||
        identity.passengerToken.length === 0 ||
        identity.passengerToken.length > MAX_PASSENGER_TOKEN_LENGTH
      ) {
        throw new HoldCoreError(
          ErrorCode.VALIDATION_ERROR,
          'passengerToken must be a non-empty trip-scoped token.',
        );
      }

      if (
        !Number.isInteger(identity.passengerKeyVersion) ||
        identity.passengerKeyVersion < 1
      ) {
        throw new HoldCoreError(
          ErrorCode.VALIDATION_ERROR,
          'passengerKeyVersion must be a positive integer.',
        );
      }
    }
  }

  /**
   * Retry only whole transactions for known transient database faults or an
   * owner/key insert race. Exclusion violations are final refusals, never
   * retried until they happen to pass.
   */
  private async runInTransaction<T>(
    work: (ctx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.unitOfWork.withTransaction(work);
      } catch (error) {
        const kind = classifyDatabaseError(error);

        if (kind === 'seat-taken') {
          throw new HoldCoreError(
            ErrorCode.SEAT_TAKEN,
            'A seat was taken while this hold was being created.',
          );
        }

        if (kind === 'passenger-overlap') {
          throw new HoldCoreError(
            ErrorCode.PASSENGER_OVERLAP,
            'A passenger already has an overlapping claim on this trip.',
          );
        }

        if (
          (kind === 'retry' || isTransientDatabaseError(error)) &&
          attempt < MAX_ATTEMPTS
        ) {
          lastError = error;
          this.logger.warn(
            `Hold transaction retry ${attempt}/${MAX_ATTEMPTS}: ${databaseCode(error) ?? 'transient'}`,
          );
          continue;
        }

        if (kind === 'retry') {
          throw new HoldCoreError(
            ErrorCode.CONFLICT,
            'The hold could not be committed after concurrent updates.',
          );
        }

        throw error;
      }
    }

    throw lastError ?? new Error('Hold transaction exhausted its retries.');
  }
}

function fingerprintOf(request: CreateHoldRequest): string {
  const canonical = {
    ownerId: request.ownerId,
    legs: [...request.legs]
      .map((leg) => [
        leg.tripId,
        leg.travelClassId,
        leg.originStationId,
        leg.destinationStationId,
      ])
      .sort((a, b) => a.join(':').localeCompare(b.join(':'))),
    passengers: [...request.passengers]
      .map((passenger) => [
        passenger.passengerRef,
        [...passenger.identities]
          .map((identity) => [
            identity.tripId,
            identity.passengerToken,
            identity.passengerKeyVersion,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function releaseFingerprint(ownerId: string): string {
  return createHash('sha256').update(`release:${ownerId}`).digest('hex');
}

function mapExpiryError(error: unknown): HoldCoreError {
  if (error instanceof HoldExpiryError) {
    if (error.code === 'SALES_CLOSED') {
      return new HoldCoreError(ErrorCode.SALES_CLOSED, error.message);
    }
    if (error.code === 'HOLD_EXPIRED') {
      return new HoldCoreError(ErrorCode.HOLD_TERMINAL, error.message);
    }
    return new HoldCoreError(ErrorCode.VALIDATION_ERROR, error.message);
  }
  return new HoldCoreError(
    ErrorCode.INTERNAL_SERVER_ERROR,
    error instanceof Error ? error.message : 'Hold expiry failed.',
  );
}

type DatabaseErrorKind = 'retry' | 'seat-taken' | 'passenger-overlap' | null;

function classifyDatabaseError(error: unknown): DatabaseErrorKind {
  const code = databaseCode(error);
  const constraint = databaseConstraint(error);

  if (code === '40001' || code === '40P01') return 'retry';

  if (code === '23505') {
    if (
      constraint === 'uq_seat_hold_group_owner_active' ||
      constraint === 'uq_seat_hold_group_booking_key'
    ) {
      return 'retry';
    }
    return null;
  }

  if (code === '23P01') {
    if (constraint === 'excl_seat_occupation_passenger_overlap') {
      return 'passenger-overlap';
    }
    if (constraint === 'excl_seat_occupation_overlap') {
      return 'seat-taken';
    }
  }

  return null;
}

function isTransientDatabaseError(error: unknown): boolean {
  const code = databaseCode(error);
  return code === '40001' || code === '40P01';
}

function databaseCode(error: unknown): string | undefined {
  return databaseField(error, 'code');
}

function databaseConstraint(error: unknown): string | undefined {
  return databaseField(error, 'constraint');
}

function databaseField(
  error: unknown,
  field: 'code' | 'constraint',
): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const direct = (error as Record<string, unknown>)[field];
  if (typeof direct === 'string') return direct;

  const driver = (error as { driverError?: unknown }).driverError;
  if (typeof driver === 'object' && driver !== null) {
    const nested = (driver as Record<string, unknown>)[field];
    if (typeof nested === 'string') return nested;
  }

  return undefined;
}
