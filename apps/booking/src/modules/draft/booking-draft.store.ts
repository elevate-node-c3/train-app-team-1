import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  AllocationOutcome,
  ErrorCode,
  SEATS_SPLIT_NOTICE,
  type HoldLifecyclePayloadV1,
  type HoldSnapshot,
  type ResolvedHoldPassenger,
} from '@app/contracts';
import {
  BookingDraftEntity,
  type BookingHoldFailure,
  type BookingHoldIntent,
} from './entities/booking-draft.entity.js';
import { BookingDraftError } from './booking-draft.errors.js';

/** All locks end before any remote call. The primary key is the booking key. */
@Injectable()
export class BookingDraftStore {
  constructor(
    @InjectRepository(BookingDraftEntity)
    private readonly repository: Repository<BookingDraftEntity>,
  ) {}

  async createIntent(
    id: string,
    userId: string,
    requestFingerprint: string,
    holdIntent: BookingHoldIntent,
  ): Promise<BookingDraftEntity> {
    return this.database(async () => {
      await this.repository
        .createQueryBuilder()
        .insert()
        .into(BookingDraftEntity)
        .values({
          id,
          userId,
          requestFingerprint,
          holdIntent,
          status: 'PENDING',
          expiresAt: null,
          legs: [],
          reconciliationPending: true,
        })
        .orIgnore()
        .execute();
      const draft = await this.repository.findOneByOrFail({ id });
      if (
        draft.userId !== userId ||
        draft.requestFingerprint !== requestFingerprint
      ) {
        throw new BookingDraftError(ErrorCode.BOOKING_KEY_CONFLICT);
      }
      return draft;
    });
  }

  findOwned(id: string, userId: string): Promise<BookingDraftEntity | null> {
    return this.database(() => this.repository.findOneBy({ id, userId }));
  }

  async rememberPassengers(
    id: string,
    userId: string,
    passengers: ResolvedHoldPassenger[],
  ): Promise<BookingDraftEntity> {
    return this.required(
      await this.locked(id, userId, (draft) => {
        if (
          draft.passengerSnapshot !== null ||
          draft.releaseRequested ||
          draft.holdFailure
        )
          return false;
        draft.passengerSnapshot = passengers;
        return true;
      }),
    );
  }

  async requestHold(
    id: string,
    userId: string,
  ): Promise<{
    draft: BookingDraftEntity;
    alreadyRequested: boolean;
  }> {
    let alreadyRequested = false;
    const draft = this.required(
      await this.locked(id, userId, (current) => {
        alreadyRequested = current.holdRequested;
        if (current.releaseRequested || current.holdFailure || alreadyRequested)
          return false;
        if (!current.passengerSnapshot)
          throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
        current.holdRequested = true;
        return true;
      }),
    );
    return { draft, alreadyRequested };
  }

  async requestRelease(
    id: string,
    userId: string,
  ): Promise<BookingDraftEntity> {
    return this.required(
      await this.locked(id, userId, (draft) => {
        if (!draft.holdIntent)
          throw new BookingDraftError(ErrorCode.HOLD_NOT_FOUND);
        draft.releaseRequested = true;
        draft.reconciliationPending = true;
        return true;
      }),
    );
  }

  async rejectIntent(
    id: string,
    userId: string,
    failure: BookingHoldFailure,
    phase: 'identity' | 'inventory',
  ): Promise<BookingDraftEntity> {
    return this.required(
      await this.locked(id, userId, (draft) => {
        if (
          draft.holdVersion > 0 ||
          draft.releaseRequested ||
          (phase === 'identity' && draft.passengerSnapshot)
        )
          return false;
        draft.holdFailure = failure;
        draft.status = 'FAILED';
        draft.reconciliationPending = false;
        return true;
      }),
    );
  }

  async applySnapshot(snapshot: HoldSnapshot): Promise<BookingDraftEntity> {
    return this.required(
      await this.locked(snapshot.bookingKey, snapshot.ownerId, (draft) =>
        projectHoldSnapshot(draft, snapshot),
      ),
    );
  }

  async applyEvent(
    payload: HoldLifecyclePayloadV1,
  ): Promise<BookingDraftEntity | null> {
    return this.locked(payload.bookingKey, payload.ownerId, (draft) => {
      // A late event must neither adopt a legacy draft nor resurrect a terminal key.
      if (
        !draft.holdIntent ||
        payload.aggregateVersion <= draft.holdVersion ||
        (draft.holdId !== null && draft.holdId !== payload.holdId) ||
        (draft.holdState !== null &&
          draft.holdState !== 'HELD' &&
          payload.state === 'HELD')
      ) {
        return false;
      }
      if (
        payload.legs.length !== draft.holdIntent.legs.length ||
        draft.holdIntent.legs.some(
          (input) =>
            !payload.legs.some(
              (leg) =>
                leg.tripId === input.tripId &&
                leg.travelClassId === input.travelClassId &&
                leg.originStationId === input.originStationId &&
                leg.destinationStationId === input.destinationStationId,
            ),
        )
      ) {
        return false;
      }
      draft.holdId = payload.holdId;
      draft.holdVersion = payload.aggregateVersion;
      draft.holdState = payload.state;
      draft.expiresAt =
        payload.expiresAt === null ? null : new Date(payload.expiresAt);
      draft.extensionUsed = payload.extensionUsed;
      draft.holdFailure = null;
      if (payload.state !== 'HELD') draft.status = 'CANCELLED';
      else if (draft.status !== 'CONFIRMED') draft.status = 'PENDING';
      draft.legs = draft.legs.map((leg) => ({
        ...leg,
        expiresAt: payload.expiresAt ?? undefined,
      }));
      // Events deliberately lack assignments and serverNow. GET fills receipts.
      draft.reconciliationPending = true;
      return true;
    });
  }

  private locked(
    id: string,
    userId: string,
    change: (draft: BookingDraftEntity) => boolean,
  ): Promise<BookingDraftEntity | null> {
    return this.database(() =>
      this.repository.manager.transaction(async (manager) => {
        const repository = manager.getRepository(BookingDraftEntity);
        const draft = await repository.findOne({
          where: { id, userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!draft) return null;
        if (change(draft)) await repository.save(draft);
        return draft;
      }),
    );
  }

  private required(draft: BookingDraftEntity | null): BookingDraftEntity {
    if (!draft) throw new BookingDraftError(ErrorCode.HOLD_NOT_FOUND);
    return draft;
  }

  private async database<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BookingDraftError) throw error;
      // QueryFailedError can include passenger_snapshot parameters. Never propagate it.
      throw new BookingDraftError(ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
  }
}

/** Shared by the locked save and the recoverable, known-success response fallback. */
export function projectHoldSnapshot(
  draft: BookingDraftEntity,
  snapshot: HoldSnapshot,
): boolean {
  if (
    snapshot.version < draft.holdVersion ||
    (draft.holdId !== null && draft.holdId !== snapshot.holdId) ||
    (draft.holdState !== null &&
      draft.holdState !== 'HELD' &&
      snapshot.state === 'HELD')
  )
    return false;
  // Same-version GET may fill an event-only projection, but cannot change its state.
  if (
    snapshot.version === draft.holdVersion &&
    draft.holdState !== null &&
    (draft.holdState !== snapshot.state ||
      draft.extensionUsed !== snapshot.extensionUsed ||
      (draft.expiresAt?.toISOString() !== snapshot.expiresAt &&
        !(draft.expiresAt === null && snapshot.expiresAt === null)))
  )
    return false;
  if (
    snapshot.version === draft.holdVersion &&
    draft.holdServerNow &&
    draft.holdServerNow.getTime() > Date.parse(snapshot.serverNow) &&
    !draft.reconciliationPending
  )
    return false;
  draft.holdId = snapshot.holdId;
  draft.holdVersion = snapshot.version;
  draft.holdState = snapshot.state;
  draft.holdSnapshot = snapshot;
  draft.holdServerNow = new Date(snapshot.serverNow);
  draft.expiresAt =
    snapshot.expiresAt === null ? null : new Date(snapshot.expiresAt);
  draft.extensionUsed = snapshot.extensionUsed;
  draft.holdFailure = null;
  draft.reconciliationPending =
    draft.releaseRequested && snapshot.state === 'HELD';
  if (snapshot.state !== 'HELD') draft.status = 'CANCELLED';
  else if (draft.status !== 'CONFIRMED') draft.status = 'PENDING';
  const passengers = draft.passengerSnapshot ?? [];
  // Request order is retained even if Inventory canonicalizes its receipt order.
  draft.legs = (draft.holdIntent?.legs ?? []).flatMap((input) => {
    const leg = snapshot.legs.find(
      (candidate) => candidate.tripId === input.tripId,
    );
    if (!leg) return [];
    const assignments = passengers.flatMap((passenger) => {
      const assignment = snapshot.assignments.find(
        (candidate) =>
          candidate.tripId === input.tripId &&
          candidate.passengerRef === passenger.passengerRef,
      );
      return assignment ? [{ passenger, assignment }] : [];
    });
    return [
      {
        holdId: snapshot.holdId,
        ...input,
        allocationOutcome: leg.outcome,
        seats: assignments.map(
          ({ passenger, assignment }) =>
            `${passenger.displayName} \u00b7 ${assignment.label ?? `Coach ${assignment.coachNumber} \u00b7 Seat ${assignment.seatNumber}`}`,
        ),
        assignedSeats: assignments.map(({ assignment }) => ({
          seatId: assignment.tripSeatId,
          coachNumber: assignment.coachNumber,
          seatNumber: assignment.seatNumber,
          rowNumber: assignment.rowNumber,
          ...(assignment.label ? { label: assignment.label } : {}),
        })),
        ...(leg.outcome === AllocationOutcome.SPLIT
          ? { splitNotice: SEATS_SPLIT_NOTICE }
          : {}),
        expiresAt: snapshot.expiresAt ?? undefined,
      },
    ];
  });
  return true;
}
