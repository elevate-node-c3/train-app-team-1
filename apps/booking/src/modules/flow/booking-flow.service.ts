import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CALLER_ACCOUNT_ID_KEY, CORRELATION_ID_KEY } from '@app/common';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import { messageOf } from '@app/messaging/error-message.js';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import {
  ErrorCode,
  type BookingResponse,
  type ContinueBookingRequest,
  type QuoteBookingResponse,
  type SubmitBookingRequest,
} from '@app/contracts';

import { BookingDraftService } from '../draft/booking-draft.service.js';
import type { BookingDraftEntity } from '../draft/entities/booking-draft.entity.js';
import {
  BookingFlowError,
  BookingFlowFault,
  refusalOf,
} from './booking-flow-error.js';
import {
  buildBookingAbandoned,
  buildBookingAwaitingPayment,
  buildBookingExpired,
} from './booking-flow-events.factory.js';
import { BookingFlowRepository } from './booking-flow.repository.js';
import { toBookingResponse } from './booking-flow.response.js';
import { isSameSubmission, validateSubmit } from './booking-flow.validator.js';
import { BOOKING_CURRENCY, priceBooking } from './booking-total.js';
import { FlowGrpcClientsService } from './flow-grpc-clients.service.js';

/** Steps the flow walks on its own before the traveller is asked to pay. */
const PRE_PAYMENT_STEPS = 4;

/** Terminal: nothing a traveller does moves the flow out of these. */
const TERMINAL_STATES = ['expired', 'abandoned', 'failed'];

/**
 * The checkout state machine, and nothing else: no SQL, no transport, no
 * timers. BookingFlowRepository owns the writes, BookingDraftService owns the
 * hold, and the worker drives whatever needs resuming.
 */
@Injectable()
export class BookingFlowService {
  private readonly logger = new Logger(BookingFlowService.name);

  constructor(
    private readonly repository: BookingFlowRepository,
    private readonly drafts: BookingDraftService,
    private readonly clients: FlowGrpcClientsService,
    private readonly cls: ClsService,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  /**
   * A repeated submit resumes the booking it already made; only a new one
   * reads identity, so a retry is never refused by a later passenger edit.
   */
  async submit(request: SubmitBookingRequest): Promise<BookingResponse> {
    validateSubmit(request);
    const userId = this.callerId();
    const correlationId = this.correlationId();

    let draft = await this.repository.findByIdempotencyKey(
      userId,
      request.idempotencyKey,
    );

    if (!draft) {
      await this.refuseAlreadyBooked(userId, request);
      await this.repository.startFlow({
        id: randomUUID(),
        userId,
        idempotencyKey: request.idempotencyKey,
        correlationId,
        holdIntent: {
          legs: request.legs.map((leg) => ({
            tripId: leg.tripId,
            travelClassId: request.travelClassId,
            originStationId: leg.originStationId,
            destinationStationId: leg.destinationStationId,
          })),
          passengerRefs: request.passengerIds,
        },
      });
      draft = await this.repository.findByIdempotencyKey(
        userId,
        request.idempotencyKey,
      );
    }

    if (!draft) {
      throw new BookingFlowFault('The booking flow could not be persisted');
    }
    if (!isSameSubmission(draft, request)) {
      throw new BookingFlowError(ErrorCode.BOOKING_KEY_CONFLICT);
    }

    await this.advance(draft.id);
    return this.read(draft.id);
  }

  async continueToPayment(
    request: ContinueBookingRequest,
  ): Promise<BookingResponse> {
    const draft = await this.ownedDraft(request.bookingReference);
    await this.expireIfDue(draft.id);
    const current = await this.require(draft.id);

    if (current.flowState === 'awaiting_payment' || this.isTerminal(current)) {
      return toBookingResponse(current);
    }
    if (current.flowState === 'payment_starting') {
      await this.startPayment(current.id);
      return this.read(current.id);
    }
    // No recorded acceptance, no charge, and the flow stays where it is.
    if (current.flowState === 'seats_held' && !current.termsAcceptedAt) {
      throw new BookingFlowError(ErrorCode.TERMS_REQUIRED);
    }
    if (!(await this.repository.beginPayment(current.id))) {
      await this.expireIfDue(current.id);
      const settled = await this.require(current.id);
      if (settled.flowState === 'awaiting_payment') {
        return toBookingResponse(settled);
      }
      throw new BookingFlowError(ErrorCode.CONFLICT);
    }

    await this.startPayment(current.id);
    return this.read(current.id);
  }

  /** Records the Terms and Privacy Policy acceptance once, with its time. */
  async acceptTerms(request: ContinueBookingRequest): Promise<BookingResponse> {
    const draft = await this.ownedDraft(request.bookingReference);
    await this.expireIfDue(draft.id);
    await this.repository.acceptTerms(draft.id, new Date());

    const current = await this.require(draft.id);
    if (!current.termsAcceptedAt) {
      throw new BookingFlowError(ErrorCode.TERMS_REQUIRED);
    }
    return toBookingResponse(current);
  }

  async abandon(request: ContinueBookingRequest): Promise<BookingResponse> {
    const draft = await this.ownedDraft(request.bookingReference);
    await this.expireIfDue(draft.id);

    if (await this.repository.abandon(draft.id)) {
      const abandoned = await this.require(draft.id);
      await this.publish(abandoned, buildBookingAbandoned);
    }
    // Released now, not when the hold would have run out (BR-25).
    await this.compensate(draft.id);
    return this.read(draft.id);
  }

  async get(request: ContinueBookingRequest): Promise<BookingResponse> {
    const draft = await this.ownedDraft(request.bookingReference);
    await this.expireIfDue(draft.id);
    return this.read(draft.id);
  }

  /** Inventory says a hold is gone; the flows holding it are expired. */
  async onHoldExpired(holdId: string): Promise<void> {
    for (const id of await this.repository.expireByHoldId(holdId)) {
      const expired = await this.require(id);
      await this.publish(expired, buildBookingExpired);
      await this.compensate(id);
    }
  }

  /** Inventory extended a hold; the flow may keep its seats longer. */
  async onHoldExtended(holdId: string, expiresAt: string): Promise<void> {
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime())) {
      throw new BookingFlowFault('Inventory sent an invalid extended expiry');
    }
    await this.repository.extendExpiry(holdId, expiry);
  }

  /**
   * Walks quote -> price -> hold. Each step is guarded, so a resumed flow
   * picks up exactly where it stopped and a duplicate request is a no-op.
   */
  async advance(id: string): Promise<void> {
    for (let step = 0; step < PRE_PAYMENT_STEPS; step += 1) {
      const draft = await this.require(id);
      switch (draft.flowState) {
        case 'quote_pending':
          await this.lockPrice(draft);
          continue;
        case 'price_locked':
          await this.repository.beginHold(id);
          continue;
        case 'hold_pending':
          await this.hold(draft);
          return;
        default:
          return;
      }
    }
  }

  /** Locks the fare for this booking (BR-30) and totals it (BR-31). */
  private async lockPrice(draft: BookingDraftEntity): Promise<void> {
    const quote = await this.quote(draft);
    const quotedLegs = quote.legs ?? [];

    if (
      quotedLegs.length !== draft.bookingLegs.length ||
      quotedLegs.some((leg) => leg.fare?.currency !== BOOKING_CURRENCY)
    ) {
      throw new BookingFlowFault('Catalog returned an unusable quote');
    }
    // D7, BR-20: the server re-checks the return leg against the outbound.
    if (
      quotedLegs.length === 2 &&
      Date.parse(quotedLegs[1].departure.at.iso) <=
        Date.parse(quotedLegs[0].arrival.at.iso)
    ) {
      await this.repository.failBeforeHold(draft.id);
      throw new BookingFlowError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'legs[1].tripId',
          rejectedValue: draft.bookingLegs[1].tripId,
          issueKey: 'ISSUE_RETURN_DEPARTS_BEFORE_OUTBOUND_ARRIVES',
          actionKey: 'ACTION_PICK_LATER_RETURN_TRAIN',
        },
      ]);
    }

    const price = priceBooking(
      quotedLegs.map((leg) => leg.fare.amountMinor),
      draft.passengerCount,
    );
    await this.repository.lockPrice(
      draft.id,
      price,
      quotedLegs,
      quote.travelClass,
    );
  }

  private async quote(
    draft: BookingDraftEntity,
  ): Promise<QuoteBookingResponse> {
    try {
      return await this.clients.quote(
        {
          legs: draft.bookingLegs,
          travelClassId: draft.travelClassId ?? '',
        },
        draft.correlationId ?? undefined,
      );
    } catch (error: unknown) {
      if (!isTransient(error)) await this.repository.failBeforeHold(draft.id);
      throw this.remoteFailure(error, 'catalog quote');
    }
  }

  /**
   * One CreateHold for every leg and passenger. Inventory commits them
   * together, so there is no partial hold to compensate and no per-leg loop.
   */
  private async hold(draft: BookingDraftEntity): Promise<void> {
    try {
      await this.drafts.resolveAndHold(draft, draft.holdIntent!);
    } catch (error: unknown) {
      if (isTransient(error)) throw error;
      await this.repository.failAfterHold(draft.id);
      await this.compensate(draft.id);
      throw this.holdRefusal(error, draft);
    }

    const held = await this.require(draft.id);
    const expiresAt = held.expiresAt;
    if (!expiresAt) {
      throw new BookingFlowFault('Inventory held seats with no expiry');
    }

    const expired = expiresAt.getTime() <= Date.now();
    await this.repository.recordHold(draft.id, expiresAt, expired);
    if (expired) {
      await this.publish(await this.require(draft.id), buildBookingExpired);
      await this.compensate(draft.id);
    }
  }

  /** Names the train a refusal is about, so the client can point at it. */
  private holdRefusal(error: unknown, draft: BookingDraftEntity): unknown {
    const refusal = refusalOf(error);
    const tripId = draft.bookingLegs[0]?.tripId ?? '';
    const field = 'legs[0].tripId';

    if (refusal?.code === ErrorCode.INSUFFICIENT_SEATS) {
      return new BookingFlowError(ErrorCode.INSUFFICIENT_SEATS, [
        {
          field,
          rejectedValue: tripId,
          issueKey: 'ISSUE_NOT_ENOUGH_SEATS_ON_TRAIN',
          actionKey: 'ACTION_FEWER_PASSENGERS_OR_ANOTHER_CLASS',
        },
      ]);
    }
    if (
      refusal?.code === ErrorCode.SEAT_ALREADY_TAKEN ||
      refusal?.code === ErrorCode.SEAT_TAKEN
    ) {
      return new BookingFlowError(ErrorCode.SEAT_ALREADY_TAKEN, [
        {
          field,
          rejectedValue: tripId,
          issueKey: 'ISSUE_SEATS_JUST_TAKEN',
          actionKey: 'ACTION_PICK_ANOTHER_TRAIN_OR_CLASS',
        },
      ]);
    }
    if (refusal?.code === ErrorCode.SALES_CLOSED) {
      return new BookingFlowError(ErrorCode.SALES_CLOSED, [
        {
          field,
          rejectedValue: tripId,
          issueKey: 'ISSUE_SALES_CLOSED_FOR_TRAIN',
          actionKey: 'ACTION_PICK_ANOTHER_TRAIN',
        },
      ]);
    }
    return error;
  }

  /** Starts the charge, then decides whether the hold still allows paying. */
  async startPayment(id: string): Promise<void> {
    const draft = await this.require(id);
    if (draft.flowState !== 'payment_starting') return;

    const charge = await this.clients.startCharge(
      {
        bookingReference: draft.id,
        amountPiastres: draft.totalPiastres ?? 0,
        currency: BOOKING_CURRENCY,
        idempotencyKey: `booking:${draft.id}:charge`,
      },
      draft.correlationId ?? undefined,
    );
    if (!charge.paymentReference) {
      throw new BookingFlowFault('Payment returned no reference');
    }

    const settled = await this.repository.recordPaymentStarted(
      id,
      charge.paymentReference,
    );
    if (settled === 'awaiting_payment') {
      await this.publish(await this.require(id), buildBookingAwaitingPayment);
      return;
    }
    if (settled === 'expired') {
      await this.publish(await this.require(id), buildBookingExpired);
    }
    await this.compensate(id);
  }

  /** Expires one flow whose hold has run out, and starts putting it back. */
  async expireIfDue(id: string): Promise<void> {
    if (!(await this.repository.expireIfDue(id))) return;
    await this.publish(await this.require(id), buildBookingExpired);
    await this.compensate(id);
  }

  /**
   * Gives back whatever this booking took: the seats first, then the charge.
   * Releasing and cancelling are both idempotent, so a retry repeats them.
   */
  async compensate(id: string): Promise<void> {
    const draft = await this.require(id);
    if (!this.isTerminal(draft)) return;
    if (draft.compensationStatus !== 'pending') return;

    try {
      if (draft.holdId && !draft.holdReleased) {
        await this.drafts.releaseHold(draft.userId, draft.id, 'en');
        await this.repository.markHoldReleased(id);
      }

      const afterRelease = await this.require(id);
      if (
        afterRelease.paymentAttempted &&
        !afterRelease.chargeCancelled &&
        !afterRelease.latePayment
      ) {
        await this.cancelCharge(afterRelease);
      }

      await this.repository.completeCompensation(id);
    } catch (error: unknown) {
      await this.recordCompensationFailure(id, error);
    }
  }

  private async cancelCharge(draft: BookingDraftEntity): Promise<void> {
    let reference = draft.paymentReference;
    if (!reference) {
      // The charge may have been started without its reference reaching us.
      const charge = await this.clients.startCharge(
        {
          bookingReference: draft.id,
          amountPiastres: draft.totalPiastres ?? 0,
          currency: BOOKING_CURRENCY,
          idempotencyKey: `booking:${draft.id}:charge`,
        },
        draft.correlationId ?? undefined,
      );
      reference = charge.paymentReference;
      await this.repository.recordPaymentReference(draft.id, reference);
    }

    const cancellation = await this.clients.cancelCharge(
      {
        bookingReference: draft.id,
        paymentReference: reference,
        idempotencyKey: `booking:${draft.id}:cancel`,
      },
      draft.correlationId ?? undefined,
    );

    if (cancellation.status === 'ALREADY_SUCCEEDED') {
      this.logger.error(
        `ALERT: charge ${reference} succeeded while booking ${draft.id} was compensating; late-payment recovery is required`,
      );
      await this.repository.recordLatePayment(
        draft.id,
        'Charge succeeded during compensation',
      );
      return;
    }
    if (cancellation.status !== 'CANCELLED') {
      throw new BookingFlowFault(
        `Payment answered an unexpected cancel status ${cancellation.status}`,
      );
    }
    await this.repository.markChargeCancelled(draft.id);
  }

  private async recordCompensationFailure(
    id: string,
    error: unknown,
  ): Promise<void> {
    const current = await this.require(id);
    const attempts = current.compensationAttempts + 1;
    const delay = Math.min(1_000 * 2 ** Math.min(attempts, 6), 60_000);

    await this.repository.recordCompensationFailure(
      id,
      delay,
      messageOf(error),
    );
    if (attempts >= 12) {
      await this.repository.deadLetterCompensation(
        id,
        attempts,
        messageOf(error),
      );
      this.logger.error(
        `DEAD LETTER: compensation for booking ${id} failed ${attempts} times; retry continues: ${messageOf(error)}`,
      );
    }
  }

  /** One event, in the transaction that appends it to the outbox. */
  private async publish(
    draft: BookingDraftEntity,
    build: (props: {
      eventId: string;
      correlationId: string;
      occurredAt: Date;
      bookingReference: string;
      totalPiastres: number;
    }) => Parameters<OutboxPort['append']>[1],
  ): Promise<void> {
    await this.unitOfWork.withTransaction((ctx) =>
      this.outbox.append(
        ctx,
        build({
          eventId: randomUUID(),
          correlationId: draft.correlationId ?? draft.id,
          occurredAt: new Date(),
          bookingReference: draft.id,
          totalPiastres: draft.totalPiastres ?? 0,
        }),
      ),
    );
  }

  /** A passenger already travelling on one of these trains is named (BR-57). */
  private async refuseAlreadyBooked(
    userId: string,
    request: SubmitBookingRequest,
  ): Promise<void> {
    const booked = await this.repository.findPassengerAlreadyBooked({
      userId,
      idempotencyKey: request.idempotencyKey,
      passengerIds: request.passengerIds,
      tripIds: request.legs.map((leg) => leg.tripId),
    });
    if (!booked) return;

    throw new BookingFlowError(ErrorCode.PASSENGER_ALREADY_BOOKED, [
      {
        field: `passengerIds[${request.passengerIds.indexOf(booked)}]`,
        rejectedValue: booked,
        issueKey: 'ISSUE_PASSENGER_ALREADY_BOOKED',
        actionKey: 'ACTION_REMOVE_PASSENGER_OR_PICK_ANOTHER_TRAIN',
      },
    ]);
  }

  private async read(id: string): Promise<BookingResponse> {
    return toBookingResponse(await this.require(id));
  }

  private async require(id: string): Promise<BookingDraftEntity> {
    const draft = await this.repository.findById(id);
    if (!draft) throw new BookingFlowError(ErrorCode.RESOURCE_NOT_FOUND);
    return draft;
  }

  /** A booking another traveller owns is not found, not forbidden. */
  private async ownedDraft(id: string): Promise<BookingDraftEntity> {
    const draft = await this.require(id);
    if (draft.userId !== this.callerId()) {
      throw new BookingFlowError(ErrorCode.RESOURCE_NOT_FOUND);
    }
    return draft;
  }

  private isTerminal(draft: BookingDraftEntity): boolean {
    return TERMINAL_STATES.includes(draft.flowState ?? '');
  }

  private callerId(): string {
    const caller = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
    if (!caller) throw new BookingFlowError(ErrorCode.UNAUTHORIZED);
    return caller;
  }

  private correlationId(): string {
    return this.cls.get<string>(CORRELATION_ID_KEY) ?? randomUUID();
  }

  private remoteFailure(error: unknown, name: string): unknown {
    this.logger.warn(`${name} did not complete: ${messageOf(error)}`);
    const refusal = refusalOf(error);
    if (refusal) return new BookingFlowError(refusal.code, refusal.details);
    return new BookingFlowError(ErrorCode.DEPENDENCY_UNAVAILABLE);
  }
}

/** Worth the same step again: the answer has not been decided yet. */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  // UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED
  return code === 14 || code === 4 || code === 8;
}
