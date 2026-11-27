import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { PaymentChargeEntity } from '../entities/payment-charge.entity.js';
import type { Charge, CreateChargeInput } from '../types/charge.types.js';

@Injectable()
export class PaymentChargeRepository {
  constructor(
    @InjectRepository(PaymentChargeEntity)
    private readonly charges: Repository<PaymentChargeEntity>,
  ) {}

  async findByBookingOrKey(
    bookingReference: string,
    idempotencyKey: string,
  ): Promise<Charge | undefined> {
    return (
      (await this.charges.findOne({
        where: [{ bookingReference }, { idempotencyKey }],
      })) ?? undefined
    );
  }

  async createStarted(input: CreateChargeInput): Promise<void> {
    await this.charges
      .createQueryBuilder()
      .insert()
      .into(PaymentChargeEntity)
      .values({ ...input, status: 'started' })
      .orIgnore()
      .execute();
  }

  async findByReference(
    id: string,
    bookingReference: string,
    ctx?: TransactionContext,
  ): Promise<Charge | undefined> {
    if (ctx) {
      return (
        (await entityManagerOf(ctx)
          .getRepository(PaymentChargeEntity)
          .findOne({
            where: { id, bookingReference },
            lock: { mode: 'pessimistic_write' },
          })) ?? undefined
      );
    }
    return (
      (await this.charges.findOneBy({ id, bookingReference })) ?? undefined
    );
  }

  async findByPaymentIntentId(
    intentId: string,
    ctx?: TransactionContext,
  ): Promise<Charge | undefined> {
    if (ctx) {
      return (
        (await entityManagerOf(ctx)
          .getRepository(PaymentChargeEntity)
          .findOne({
            where: { stripePaymentIntentId: intentId },
            lock: { mode: 'pessimistic_write' },
          })) ?? undefined
      );
    }
    return (
      (await this.charges.findOneBy({ stripePaymentIntentId: intentId })) ??
      undefined
    );
  }

  async savePaymentIntent(
    bookingReference: string,
    intentId: string,
  ): Promise<void> {
    const result = await this.charges
      .createQueryBuilder()
      .update()
      .set({ stripePaymentIntentId: intentId })
      .where('booking_reference = :bookingReference', { bookingReference })
      .andWhere(
        '(stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = :intentId)',
        { intentId },
      )
      .execute();
    if (!result.affected)
      throw new Error(
        'Payment intent mapping conflicts with the durable booking intent',
      );
  }

  async bindPaymentIntent(
    charge: Charge,
    intentId: string,
    ctx: TransactionContext,
  ): Promise<boolean> {
    const result = await entityManagerOf(ctx)
      .getRepository(PaymentChargeEntity)
      .createQueryBuilder()
      .update()
      .set({ stripePaymentIntentId: intentId })
      .where('id = :id', { id: charge.id })
      .andWhere(
        '(stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = :intentId)',
        { intentId },
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async claimIntentCreation(
    id: string,
    claim: string,
    customerId: string,
  ): Promise<Charge | undefined> {
    const result = await this.charges
      .createQueryBuilder()
      .update()
      .set({
        intentCreationClaim: claim,
        intentCreationStartedAt: () =>
          'COALESCE(intent_creation_started_at, now())',
        intentCreationLeaseUntil: () => "now() + interval '30 seconds'",
        stripeCustomerId: () => 'COALESCE(stripe_customer_id, :customerId)',
      })
      .where('id = :id', { id })
      .andWhere("status = 'started' AND stripe_payment_intent_id IS NULL")
      .andWhere(
        '(cancellation_requested_at IS NULL OR intent_creation_started_at IS NOT NULL)',
      )
      .andWhere(
        '(intent_creation_lease_until IS NULL OR intent_creation_lease_until <= now())',
      )
      .setParameter('customerId', customerId)
      .execute();
    if (!result.affected) return undefined;
    return (await this.charges.findOneBy({ id })) ?? undefined;
  }

  async completeIntentCreation(
    id: string,
    claim: string,
    intentId: string,
  ): Promise<void> {
    const result = await this.charges
      .createQueryBuilder()
      .update()
      .set({
        stripePaymentIntentId: intentId,
        intentCreationClaim: null,
        intentCreationLeaseUntil: null,
        intentCreationLastError: null,
      })
      .where('id = :id AND intent_creation_claim = :claim', { id, claim })
      .andWhere(
        '(stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = :intentId)',
        { intentId },
      )
      .execute();
    if (!result.affected) {
      const existing = await this.charges.findOneBy({ id });
      if (existing?.stripePaymentIntentId !== intentId) {
        throw new Error(
          'Payment intent creation claim was lost; reconciliation is required',
        );
      }
    }
  }

  async canReplayIntentCreation(id: string, claim: string): Promise<boolean> {
    return this.charges
      .createQueryBuilder('charge')
      .where('id = :id AND intent_creation_claim = :claim', { id, claim })
      .andWhere("status = 'started' AND stripe_payment_intent_id IS NULL")
      .andWhere('intent_creation_lease_until > now()')
      .andWhere("intent_creation_started_at > now() - interval '23 hours'")
      .getExists();
  }

  async releaseIntentCreation(
    id: string,
    claim: string,
    error: string,
  ): Promise<void> {
    await this.charges.update(
      { id, intentCreationClaim: claim },
      {
        intentCreationClaim: null,
        intentCreationLeaseUntil: new Date(Date.now() + 3_000),
        intentCreationLastError: error,
      },
    );
  }

  async findRecoveryPending(limit: number): Promise<Charge[]> {
    return this.charges
      .createQueryBuilder('charge')
      .where("status = 'started'")
      .andWhere(
        '(stripe_payment_intent_id IS NOT NULL OR intent_creation_started_at IS NOT NULL OR cancellation_requested_at IS NOT NULL)',
      )
      .andWhere(
        '(intent_creation_lease_until IS NULL OR intent_creation_lease_until <= now())',
      )
      .orderBy('intent_creation_lease_until', 'ASC', 'NULLS FIRST')
      .take(limit)
      .getMany();
  }

  async deferRecovery(id: string, error: string | null): Promise<void> {
    await this.charges.update(
      { id, intentCreationClaim: IsNull() },
      {
        intentCreationLeaseUntil: new Date(Date.now() + 30_000),
        intentCreationLastError: error,
      },
    );
  }

  async countRecoveryProblems(): Promise<number> {
    return this.charges
      .createQueryBuilder('charge')
      .where("status = 'started' AND intent_creation_last_error IS NOT NULL")
      .getCount();
  }

  async requestCancellation(
    id: string,
    bookingReference: string,
  ): Promise<void> {
    await this.charges
      .createQueryBuilder()
      .update()
      .set({
        cancellationRequestedAt: () =>
          'COALESCE(cancellation_requested_at, now())',
      })
      .where('id = :id AND booking_reference = :bookingReference', {
        id,
        bookingReference,
      })
      .andWhere("status = 'started'")
      .execute();
  }

  async cancelUnattempted(
    id: string,
    bookingReference: string,
  ): Promise<boolean> {
    const result = await this.charges
      .createQueryBuilder()
      .update()
      .set({ status: 'cancelled' })
      .where('id = :id AND booking_reference = :bookingReference', {
        id,
        bookingReference,
      })
      .andWhere(
        "status = 'started' AND stripe_payment_intent_id IS NULL AND intent_creation_started_at IS NULL",
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markStartedSucceeded(id: string): Promise<void> {
    await this.charges.update(
      { id, status: 'started' },
      { status: 'succeeded' },
    );
  }

  async markSucceeded(id: string, ctx: TransactionContext): Promise<boolean> {
    const result = await entityManagerOf(ctx)
      .getRepository(PaymentChargeEntity)
      .update(
        { id, status: In(['started', 'cancelled']) },
        { status: 'succeeded' },
      );
    return (result.affected ?? 0) > 0;
  }

  async cancelStarted(id: string, bookingReference: string): Promise<boolean> {
    const result = await this.charges.update(
      { id, bookingReference, status: 'started' },
      { status: 'cancelled' },
    );
    return (result.affected ?? 0) > 0;
  }

  async findStatus(
    id: string,
    bookingReference: string,
  ): Promise<Charge['status'] | undefined> {
    const charge = await this.charges.findOne({
      where: { id, bookingReference },
      select: { status: true },
    });
    return charge?.status;
  }

  async refundSucceeded(
    id: string,
    amountPiastres: number,
  ): Promise<boolean> {
    const result = await this.charges.update(
      { id, status: 'succeeded' },
      { status: 'refunded', refundAmountPiastres: amountPiastres },
    );
    return (result.affected ?? 0) > 0;
  }
}
