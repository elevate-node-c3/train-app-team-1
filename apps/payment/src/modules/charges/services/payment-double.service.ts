import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { paymentDoubleSucceededBookingsFromEnv } from '../../../config/payment-double.settings.js';
import {
  ErrorCode,
  type CancelChargeRequest,
  type CancelChargeResponse,
  type RefundChargeRequest,
  type RefundChargeResponse,
  type StartChargeRequest,
  type StartChargeResponse,
} from '@app/contracts';
import { PaymentError } from '../payment-error.js';
import { PaymentIntentService } from './payment-intent.service.js';

export interface ChargeRow {
  id: string;
  booking_reference: string;
  idempotency_key: string;
  amount_piastres: number;
  currency: string;
  status: 'started' | 'succeeded' | 'cancelled' | 'refunded';
  stripe_payment_method_id: string | null;
  stripe_customer_id?: string | null;
  stripe_payment_intent_id?: string | null;
}

interface ChargeCardRow {
  stripe_payment_method_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  status: 'active' | 'detached';
}

/**
 * Sprint 3 contract-compatible payment double. Stripe can replace this provider
 * in payment without changing the booking contract or client.
 */
@Injectable()
export class PaymentDoubleService {
  private readonly succeededBookings = paymentDoubleSucceededBookingsFromEnv();

  constructor(
    private readonly dataSource: DataSource,
    private readonly intents: PaymentIntentService,
  ) {}

  async start(request: StartChargeRequest): Promise<StartChargeResponse> {
    if (
      request.currency !== 'EGP' ||
      !Number.isInteger(request.amountPiastres) ||
      request.amountPiastres < 1
    ) {
      throw new PaymentError(ErrorCode.INVALID_PAYLOAD);
    }

    let existingCharge: ChargeRow | undefined;
    if (request.savedCardId) {
      const existing = (await this.dataSource.query(
        'SELECT * FROM payment_charge WHERE booking_reference = $1 OR idempotency_key = $2',
        [request.bookingReference, request.idempotencyKey],
      )) as ChargeRow[];
      existingCharge = existing[0];
    }

    let card: ChargeCardRow | undefined;
    if (request.savedCardId) {
      const cards = (await this.dataSource.query(
        `SELECT stripe_payment_method_id, brand, last4, exp_month, exp_year,
                status
         FROM saved_card
         WHERE id = $1 AND account_id = $2`,
        [request.savedCardId, request.accountId],
      )) as ChargeCardRow[];
      card = cards[0];
      if (!card) {
        throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
      }

      if (existingCharge) {
        if (
          existingCharge.stripe_payment_method_id !==
          card.stripe_payment_method_id
        ) {
          throw new PaymentError(ErrorCode.BOOKING_KEY_CONFLICT);
        }
        return this.replay(existingCharge, request);
      }

      if (card.status !== 'active') {
        throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
      }

      const now = new Date();
      if (
        card.exp_year < now.getUTCFullYear() ||
        (card.exp_year === now.getUTCFullYear() &&
          card.exp_month < now.getUTCMonth() + 1)
      ) {
        throw new PaymentError(ErrorCode.INVALID_PAYLOAD);
      }
    }

    await this.dataSource.query(
      `INSERT INTO payment_charge
         (id, booking_reference, idempotency_key, amount_piastres, currency, status,
          card_brand, card_last4, stripe_payment_method_id)
       VALUES ($1, $2, $3, $4, $5, 'started', $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        uuid(),
        request.bookingReference,
        request.idempotencyKey,
        request.amountPiastres,
        request.currency,
        card?.brand ?? null,
        card?.last4 ?? null,
        card?.stripe_payment_method_id ?? null,
      ],
    );
    const rows = (await this.dataSource.query(
      'SELECT * FROM payment_charge WHERE booking_reference = $1 OR idempotency_key = $2',
      [request.bookingReference, request.idempotencyKey],
    )) as ChargeRow[];
    const charge = rows[0];
    if (
      !charge ||
      charge.booking_reference !== request.bookingReference ||
      charge.idempotency_key !== request.idempotencyKey ||
      Number(charge.amount_piastres) !== request.amountPiastres
    ) {
      throw new PaymentError(ErrorCode.BOOKING_KEY_CONFLICT);
    }

    if (card) {
      await this.dataSource.query(
        `UPDATE saved_card
         SET last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND account_id = $2 AND status = 'active'`,
        [request.savedCardId, request.accountId],
      );
    }

    if (this.succeededBookings.has(request.bookingReference)) {
      await this.dataSource.query(
        "UPDATE payment_charge SET status = 'succeeded' WHERE id = $1 AND status = 'started'",
        [charge.id],
      );
    }

    const intent = await this.intents.startFor(charge);
    const status =
      this.succeededBookings.has(request.bookingReference) ||
      charge.status === 'succeeded'
        ? 'SUCCEEDED'
        : 'STARTED';

    // One PaymentIntent per booking; a retry after a decline or a restart
    // returns the intent the first attempt made.
    return { paymentReference: charge.id, status, clientSecret: intent.clientSecret };
  }

  private async replay(
    charge: ChargeRow,
    request: StartChargeRequest,
  ): Promise<StartChargeResponse> {
    if (
      charge.booking_reference !== request.bookingReference ||
      charge.idempotency_key !== request.idempotencyKey ||
      Number(charge.amount_piastres) !== request.amountPiastres
    ) {
      throw new PaymentError(ErrorCode.BOOKING_KEY_CONFLICT);
    }

    const intent = await this.intents.startFor(charge);

    return {
      paymentReference: charge.id,
      status:
        charge.status === 'succeeded'
          ? 'SUCCEEDED'
          : charge.status === 'cancelled'
            ? 'CANCELLED'
            : 'STARTED',
      clientSecret: intent.clientSecret,
    };
  }

  async cancel(request: CancelChargeRequest): Promise<CancelChargeResponse> {
    const rows = (await this.dataSource.query(
      `UPDATE payment_charge
          SET status = 'cancelled'
        WHERE id = $1 AND booking_reference = $2 AND status = 'started'
        RETURNING status`,
      [request.paymentReference, request.bookingReference],
    )) as Array<{ status: string }>;
    if (rows[0]) return { status: 'CANCELLED' };

    const existing = (await this.dataSource.query(
      'SELECT status FROM payment_charge WHERE id = $1 AND booking_reference = $2',
      [request.paymentReference, request.bookingReference],
    )) as Array<{ status: string }>;
    if (existing[0]?.status === 'succeeded') {
      return { status: 'ALREADY_SUCCEEDED' };
    }
    if (existing[0]?.status === 'cancelled') {
      return { status: 'CANCELLED' };
    }
    throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
  }

  // TODO(TA-110, Youssef Mostafa): replace this body with stripe.refunds.create
  // against the booking's PaymentIntent. The request and response shapes are the
  // contract and should not change; the refund's lifecycle is TA-110's own work.
  async refund(request: RefundChargeRequest): Promise<RefundChargeResponse> {
    const rows = (await this.dataSource.query(
      'SELECT * FROM payment_charge WHERE id = $1 AND booking_reference = $2',
      [request.paymentReference, request.bookingReference],
    )) as ChargeRow[];
    const charge = rows[0];
    if (!charge) {
      throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    }

    const refundReference = `refund_${charge.id}`;
    if (charge.status === 'refunded') {
      return {
        status: 'ALREADY_REFUNDED',
        refundReference,
        amountPiastres: charge.amount_piastres,
      };
    }
    if (charge.status !== 'succeeded') {
      throw new PaymentError(ErrorCode.CONFLICT);
    }

    await this.dataSource.query(
      `UPDATE payment_charge SET status = 'refunded' WHERE id = $1 AND status = 'succeeded'`,
      [charge.id],
    );

    return {
      status: 'REFUNDED',
      refundReference,
      amountPiastres: charge.amount_piastres,
    };
  }
}
