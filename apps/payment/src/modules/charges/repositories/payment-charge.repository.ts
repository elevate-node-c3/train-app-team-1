import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
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
  ): Promise<Charge | undefined> {
    return (
      (await this.charges.findOneBy({ id, bookingReference })) ?? undefined
    );
  }

  async findByPaymentIntentId(intentId: string): Promise<Charge | undefined> {
    return (
      (await this.charges.findOneBy({ stripePaymentIntentId: intentId })) ??
      undefined
    );
  }

  async savePaymentIntent(
    bookingReference: string,
    intentId: string,
  ): Promise<void> {
    await this.charges.update(
      { bookingReference },
      { stripePaymentIntentId: intentId },
    );
  }

  async markStartedSucceeded(id: string): Promise<void> {
    await this.charges.update(
      { id, status: 'started' },
      { status: 'succeeded' },
    );
  }

  async markSucceeded(id: string, ctx: TransactionContext): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(PaymentChargeEntity)
      .update({ id, status: Not('succeeded') }, { status: 'succeeded' });
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

  async refundSucceeded(id: string): Promise<void> {
    await this.charges.update(
      { id, status: 'succeeded' },
      { status: 'refunded' },
    );
  }
}
