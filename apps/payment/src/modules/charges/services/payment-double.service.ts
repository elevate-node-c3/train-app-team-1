import { Injectable } from '@nestjs/common';
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
import { ChargeCardRepository } from '../repositories/charge-card.repository.js';
import { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { ChargeCard, Charge } from '../types/charge.types.js';

/**
 * Sprint 3 contract-compatible payment double. Stripe can replace this provider
 * in payment without changing the booking contract or client.
 */
@Injectable()
export class PaymentDoubleService {
  private readonly succeededBookings = paymentDoubleSucceededBookingsFromEnv();

  constructor(
    private readonly charges: PaymentChargeRepository,
    private readonly cards: ChargeCardRepository,
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

    let existingCharge: Charge | undefined;
    if (request.savedCardId) {
      existingCharge = await this.charges.findByBookingOrKey(
        request.bookingReference,
        request.idempotencyKey,
      );
    }

    let card: ChargeCard | undefined;
    if (request.savedCardId) {
      card = await this.cards.findOwned(request.savedCardId, request.accountId);
      if (!card) {
        throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
      }

      if (existingCharge) {
        if (
          existingCharge.stripePaymentMethodId !== card.stripePaymentMethodId
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
        card.expYear < now.getUTCFullYear() ||
        (card.expYear === now.getUTCFullYear() &&
          card.expMonth < now.getUTCMonth() + 1)
      ) {
        throw new PaymentError(ErrorCode.INVALID_PAYLOAD);
      }
    }

    await this.charges.createStarted({
      id: uuid(),
      bookingReference: request.bookingReference,
      idempotencyKey: request.idempotencyKey,
      amountPiastres: request.amountPiastres,
      currency: request.currency,
      cardBrand: card?.brand ?? null,
      cardLast4: card?.last4 ?? null,
      stripePaymentMethodId: card?.stripePaymentMethodId ?? null,
    });
    const charge = await this.charges.findByBookingOrKey(
      request.bookingReference,
      request.idempotencyKey,
    );
    if (
      !charge ||
      charge.bookingReference !== request.bookingReference ||
      charge.idempotencyKey !== request.idempotencyKey ||
      Number(charge.amountPiastres) !== request.amountPiastres
    ) {
      throw new PaymentError(ErrorCode.BOOKING_KEY_CONFLICT);
    }

    if (request.savedCardId && card) {
      await this.cards.markUsed(request.savedCardId, request.accountId);
    }

    if (this.succeededBookings.has(request.bookingReference)) {
      await this.charges.markStartedSucceeded(charge.id);
    }

    const intent = await this.intents.startFor(charge);
    const status =
      this.succeededBookings.has(request.bookingReference) ||
      charge.status === 'succeeded'
        ? 'SUCCEEDED'
        : 'STARTED';

    // One PaymentIntent per booking; a retry after a decline or a restart
    // returns the intent the first attempt made.
    return {
      paymentReference: charge.id,
      status,
      clientSecret: intent.clientSecret,
    };
  }

  private async replay(
    charge: Charge,
    request: StartChargeRequest,
  ): Promise<StartChargeResponse> {
    if (
      charge.bookingReference !== request.bookingReference ||
      charge.idempotencyKey !== request.idempotencyKey ||
      Number(charge.amountPiastres) !== request.amountPiastres
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
    const cancelled = await this.charges.cancelStarted(
      request.paymentReference,
      request.bookingReference,
    );
    if (cancelled) return { status: 'CANCELLED' };

    const status = await this.charges.findStatus(
      request.paymentReference,
      request.bookingReference,
    );
    if (status === 'succeeded') {
      return { status: 'ALREADY_SUCCEEDED' };
    }
    if (status === 'cancelled') {
      return { status: 'CANCELLED' };
    }
    throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
  }

  // TODO(TA-110, Youssef Mostafa): replace this body with stripe.refunds.create
  // against the booking's PaymentIntent. The request and response shapes are the
  // contract and should not change; the refund's lifecycle is TA-110's own work.
  async refund(request: RefundChargeRequest): Promise<RefundChargeResponse> {
    const charge = await this.charges.findByReference(
      request.paymentReference,
      request.bookingReference,
    );
    if (!charge) {
      throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    }

    const refundReference = `refund_${charge.id}`;
    if (charge.status === 'refunded') {
      return {
        status: 'ALREADY_REFUNDED',
        refundReference,
        amountPiastres: charge.amountPiastres,
      };
    }
    if (charge.status !== 'succeeded') {
      throw new PaymentError(ErrorCode.CONFLICT);
    }

    await this.charges.refundSucceeded(charge.id);

    return {
      status: 'REFUNDED',
      refundReference,
      amountPiastres: charge.amountPiastres,
    };
  }
}
