import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { QuotedLeg, TravelClass } from '@app/contracts';

import {
  BookingDraftEntity,
  type BookingFlowState,
  type BookingHoldIntent,
} from '../draft/entities/booking-draft.entity.js';
import type { BookingPrice } from './booking-total.js';

/** A flow the resume worker has leased, with the step it stopped on. */
export type LeasedFlow = {
  id: string;
  flowState: BookingFlowState;
};

/** Flows that still hold, or are about to hold, their seats. */
const LIVE_STATES: readonly BookingFlowState[] = [
  'quote_pending',
  'price_locked',
  'hold_pending',
  'seats_held',
  'payment_starting',
  'awaiting_payment',
];

/** States from which a traveller action can still move the flow. */
const HELD_STATES: readonly BookingFlowState[] = [
  'seats_held',
  'payment_starting',
  'awaiting_payment',
];

const LEASE_SECONDS = 20;
const CLAIM_LIMIT = 20;

/**
 * Every write the checkout flow makes to booking_draft. Conditional updates
 * return the rows they changed, so the service can tell a transition it won
 * from one another request already made.
 */
@Injectable()
export class BookingFlowRepository {
  constructor(
    @InjectRepository(BookingDraftEntity)
    private readonly drafts: Repository<BookingDraftEntity>,
  ) {}

  findById(id: string): Promise<BookingDraftEntity | null> {
    return this.drafts.findOne({ where: { id } });
  }

  findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<BookingDraftEntity | null> {
    return this.drafts.findOne({ where: { userId, idempotencyKey } });
  }

  /**
   * The unique (user_id, idempotency_key) index makes a concurrent duplicate a
   * no-op, so both requests end up on the same booking.
   */
  async startFlow(input: {
    id: string;
    userId: string;
    idempotencyKey: string;
    correlationId: string;
    holdIntent: BookingHoldIntent;
  }): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .insert()
      .into(BookingDraftEntity)
      .values({
        id: input.id,
        userId: input.userId,
        status: 'PENDING',
        flowState: 'quote_pending',
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        holdIntent: input.holdIntent,
        resumeNextAttemptAt: new Date(),
      })
      .orIgnore()
      .execute();
  }

  /** Locks the price (BR-30): a later fare change never reaches this booking. */
  async lockPrice(
    id: string,
    price: BookingPrice,
    quotedLegs: QuotedLeg[],
    travelClass: TravelClass | undefined,
  ): Promise<boolean> {
    return this.transition(id, ['quote_pending'], {
      flowState: 'price_locked',
      fareTotalPiastres: price.fareTotalPiastres,
      bookingFeePiastres: price.bookingFeePiastres,
      totalPiastres: price.totalPiastres,
      quotedLegs,
      travelClass: travelClass ?? null,
    });
  }

  async beginHold(id: string): Promise<boolean> {
    return this.transition(id, ['price_locked'], { flowState: 'hold_pending' });
  }

  /** Records the hold inventory granted, or marks it already gone. */
  async recordHold(
    id: string,
    expiresAt: Date,
    expired: boolean,
  ): Promise<boolean> {
    return this.transition(
      id,
      ['hold_pending'],
      expired
        ? {
            flowState: 'expired',
            expiresAt,
            compensationStatus: 'pending',
            compensationNextAttemptAt: new Date(),
          }
        : { flowState: 'seats_held', expiresAt, compensationStatus: 'none' },
    );
  }

  /** Nothing is held before the hold step, so nothing needs compensating. */
  async failBeforeHold(id: string): Promise<boolean> {
    return this.transition(id, ['quote_pending', 'price_locked'], {
      flowState: 'failed',
      status: 'FAILED',
      compensationStatus: 'none',
      resumeNextAttemptAt: null,
    });
  }

  /** A hold was granted and then refused; its seats must go back. */
  async failAfterHold(id: string): Promise<boolean> {
    return this.transition(id, ['hold_pending'], {
      flowState: 'failed',
      status: 'FAILED',
      compensationStatus: 'pending',
      compensationNextAttemptAt: new Date(),
      resumeNextAttemptAt: null,
    });
  }

  /** Acceptance is recorded once, with its time; the server is the guard. */
  async acceptTerms(id: string, now: Date): Promise<boolean> {
    const result = await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({ termsAcceptedAt: now, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('flow_state = :state', { state: 'seats_held' })
      .andWhere('expires_at > now()')
      .andWhere('terms_accepted_at IS NULL')
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /** Payment may only start on a live hold whose terms were accepted. */
  async beginPayment(id: string): Promise<boolean> {
    const result = await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({
        flowState: 'payment_starting',
        paymentAttempted: true,
        resumeNextAttemptAt: () => 'now()',
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('flow_state = :state', { state: 'seats_held' })
      .andWhere('expires_at > now()')
      .andWhere('terms_accepted_at IS NOT NULL')
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * The charge exists; whether the traveller may still pay for it depends on
   * the hold, which may have run out while payment was starting.
   */
  async recordPaymentStarted(
    id: string,
    paymentReference: string,
  ): Promise<BookingFlowState | null> {
    const started = await this.transition(id, ['payment_starting'], {
      paymentReference,
      flowState: 'awaiting_payment',
      resumeNextAttemptAt: null,
    }, 'expires_at > now()');
    if (started) return 'awaiting_payment';

    const expired = await this.transition(id, ['payment_starting'], {
      paymentReference,
      flowState: 'expired',
      compensationStatus: 'pending',
      compensationNextAttemptAt: new Date(),
      resumeNextAttemptAt: null,
    });
    if (expired) return 'expired';

    // Already terminal: keep the reference so compensation can cancel it.
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({ paymentReference, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('payment_reference IS NULL')
      .execute();
    return null;
  }

  async abandon(id: string): Promise<boolean> {
    return this.transition(id, HELD_STATES, {
      flowState: 'abandoned',
      status: 'CANCELLED',
      compensationStatus: 'pending',
      compensationNextAttemptAt: new Date(),
      resumeNextAttemptAt: null,
    });
  }

  /** Expires one flow whose hold has run out. */
  async expireIfDue(id: string): Promise<boolean> {
    return this.transition(id, HELD_STATES, {
      flowState: 'expired',
      compensationStatus: 'pending',
      compensationNextAttemptAt: new Date(),
      resumeNextAttemptAt: null,
    }, 'expires_at <= now()');
  }

  /** Expires every flow whose hold has run out, for the sweep. */
  async expireAllDue(): Promise<string[]> {
    const result = await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({
        flowState: 'expired',
        compensationStatus: 'pending',
        compensationNextAttemptAt: () => 'now()',
        resumeNextAttemptAt: null,
        updatedAt: () => 'now()',
      })
      .where('flow_state IN (:...states)', { states: HELD_STATES })
      .andWhere('expires_at <= now()')
      .returning('id')
      .execute();
    return idsOf(result.raw);
  }

  /** Expires the flows holding a hold inventory says is gone. */
  async expireByHoldId(holdId: string): Promise<string[]> {
    const result = await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({
        flowState: 'expired',
        compensationStatus: 'pending',
        compensationNextAttemptAt: () => 'now()',
        resumeNextAttemptAt: null,
        updatedAt: () => 'now()',
      })
      .where('hold_id = :holdId', { holdId })
      .andWhere('flow_state IN (:...states)', { states: HELD_STATES })
      .returning('id')
      .execute();
    return idsOf(result.raw);
  }

  /** An extension only ever moves the expiry later. */
  async extendExpiry(holdId: string, expiresAt: Date): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({ expiresAt, updatedAt: () => 'now()' })
      .where('hold_id = :holdId', { holdId })
      .andWhere('flow_state IN (:...states)', { states: HELD_STATES })
      .andWhere('(expires_at IS NULL OR expires_at < :expiresAt)', {
        expiresAt,
      })
      .execute();
  }

  /**
   * A passenger already travelling on one of these trains is named (BR-57).
   * A concurrent duplicate of this very submission is not another booking.
   */
  async findPassengerAlreadyBooked(input: {
    userId: string;
    idempotencyKey: string;
    passengerIds: readonly string[];
    tripIds: readonly string[];
  }): Promise<string | null> {
    const rows = (await this.drafts
      .createQueryBuilder('draft')
      .select('passenger.ref', 'ref')
      .innerJoin(
        "jsonb_array_elements_text(draft.hold_intent->'passengerRefs')",
        'passenger(ref)',
        '1 = 1',
      )
      .where('draft.user_id = :userId', { userId: input.userId })
      .andWhere('draft.idempotency_key <> :key', { key: input.idempotencyKey })
      .andWhere('draft.flow_state IN (:...states)', { states: LIVE_STATES })
      .andWhere('(draft.expires_at IS NULL OR draft.expires_at > now())')
      .andWhere('passenger.ref IN (:...passengerIds)', {
        passengerIds: input.passengerIds,
      })
      .andWhere(
        `EXISTS (
           SELECT 1 FROM jsonb_array_elements(draft.hold_intent->'legs') AS leg
            WHERE leg->>'tripId' IN (:...tripIds)
         )`,
        { tripIds: input.tripIds },
      )
      .limit(1)
      .getRawMany()) as { ref: string }[];

    return rows[0]?.ref ?? null;
  }

  async markHoldReleased(id: string): Promise<void> {
    await this.set(id, { holdReleased: true });
  }

  async markChargeCancelled(id: string): Promise<void> {
    await this.set(id, { chargeCancelled: true });
  }

  async recordPaymentReference(id: string, reference: string): Promise<void> {
    await this.set(id, { paymentReference: reference });
  }

  async completeCompensation(id: string): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({
        compensationStatus: 'complete',
        compensationNextAttemptAt: null,
        compensationLastError: null,
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('compensation_status = :pending', { pending: 'pending' })
      .execute();
  }

  /** A charge that succeeded mid-compensation needs a human, not a retry. */
  async recordLatePayment(id: string, reason: string): Promise<void> {
    await this.set(id, {
      latePayment: true,
      compensationStatus: 'late_payment',
      compensationLastError: reason,
    });
  }

  async recordCompensationFailure(
    id: string,
    delayMs: number,
    error: string,
  ): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({
        compensationAttempts: () => 'compensation_attempts + 1',
        compensationNextAttemptAt: () =>
          `now() + (${Math.trunc(delayMs)} * interval '1 millisecond')`,
        compensationLastError: error,
        leaseUntil: null,
        leaseOwner: null,
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('compensation_status = :pending', { pending: 'pending' })
      .execute();
  }

  /** Leases the steps a worker may resume, skipping another worker's rows. */
  async claimResumable(workerId: string): Promise<LeasedFlow[]> {
    const rows = (await this.drafts.query(
      `WITH due AS (
         SELECT id FROM booking_draft
          WHERE flow_state IN ('quote_pending', 'price_locked', 'hold_pending',
                               'payment_starting')
            AND resume_next_attempt_at <= now()
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY resume_next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE booking_draft draft
          SET lease_until = now() + interval '${LEASE_SECONDS} seconds',
              lease_owner = $1,
              resume_attempts = resume_attempts + 1
         FROM due WHERE draft.id = due.id
       RETURNING draft.id AS "id", draft.flow_state AS "flowState"`,
      [workerId, CLAIM_LIMIT],
    )) as LeasedFlow[];
    return rows;
  }

  async claimCompensable(workerId: string): Promise<string[]> {
    const rows = (await this.drafts.query(
      `WITH due AS (
         SELECT id FROM booking_draft
          WHERE compensation_status = 'pending'
            AND compensation_next_attempt_at <= now()
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY compensation_next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE booking_draft draft
          SET lease_until = now() + interval '${LEASE_SECONDS} seconds',
              lease_owner = $1
         FROM due WHERE draft.id = due.id
       RETURNING draft.id AS "id"`,
      [workerId, CLAIM_LIMIT],
    )) as { id: string }[];
    return rows.map((row) => row.id);
  }

  async releaseLease(id: string, workerId: string): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({ leaseUntil: null, leaseOwner: null })
      .where('id = :id', { id })
      .andWhere('lease_owner = :workerId', { workerId })
      .execute();
  }

  /** Hands a failed step back to the worker, a few seconds later. */
  async deferResume(
    id: string,
    workerId: string,
    error: string,
  ): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({
        resumeNextAttemptAt: () => "now() + interval '3 seconds'",
        leaseUntil: null,
        leaseOwner: null,
        compensationLastError: error,
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('lease_owner = :workerId', { workerId })
      .execute();
  }

  async deadLetterCompensation(
    id: string,
    attempts: number,
    error: string,
  ): Promise<void> {
    await this.drafts.query(
      `INSERT INTO booking_compensation_dead_letter
         (booking_reference, attempts, last_error)
       VALUES ($1, $2, $3)
       ON CONFLICT (booking_reference) DO UPDATE
         SET attempts = EXCLUDED.attempts,
             last_error = EXCLUDED.last_error,
             updated_at = now()`,
      [id, attempts, error],
    );
  }

  private async set(
    id: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    await this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({ ...values, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .execute();
  }

  /** A guarded transition: it changed a row, or another request got there. */
  private async transition(
    id: string,
    from: readonly BookingFlowState[],
    values: Record<string, unknown>,
    extraCondition?: string,
  ): Promise<boolean> {
    let query = this.drafts
      .createQueryBuilder()
      .update(BookingDraftEntity)
      .set({ ...values, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('flow_state IN (:...from)', { from });
    if (extraCondition) query = query.andWhere(extraCondition);

    const result = await query.execute();
    return (result.affected ?? 0) > 0;
  }
}

function idsOf(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((row: { id: string }) => row.id).filter(Boolean)
    : [];
}
