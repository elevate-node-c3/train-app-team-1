import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
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
 * Real charge orchestration. Only the explicitly deferred refund body remains
 * a contract double until TA-110 supplies Stripe refund execution.
 */
@Injectable()
export class PaymentDoubleService {
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

    const existingCharge = await this.charges.findByBookingOrKey(
      request.bookingReference,
      request.idempotencyKey,
    );

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

    if (existingCharge) return this.replay(existingCharge, request);

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
      Number(charge.amountPiastres) !== request.amountPiastres ||
      (card && charge.stripePaymentMethodId !== card.stripePaymentMethodId)
    ) {
      throw new PaymentError(ErrorCode.BOOKING_KEY_CONFLICT);
    }

    if (request.savedCardId && card) {
      await this.cards.markUsed(request.savedCardId, request.accountId);
    }

    return this.replay(charge, request);
  }

  private async replay(
    charge: Charge,
    request: StartChargeRequest,
  ): Promise<StartChargeResponse> {
    if (
      charge.bookingReference !== request.bookingReference ||
      charge.idempotencyKey !== request.idempotencyKey ||
      Number(charge.amountPiastres) !== request.amountPiastres ||
      charge.currency !== request.currency
    ) {
      throw new PaymentError(ErrorCode.BOOKING_KEY_CONFLICT);
    }

    if (charge.status !== 'started' || charge.cancellationRequestedAt) {
      return {
        paymentReference: charge.id,
        status: charge.status.toUpperCase(),
        clientSecret: '',
      };
    }
    const intent = await this.intents.startFor(charge);
    const current = await this.charges.findByReference(
      charge.id,
      charge.bookingReference,
    );
    if (!current) throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    const status =
      current.status !== 'started'
        ? current.status.toUpperCase()
        : intent.status === 'succeeded'
          ? 'SUCCEEDED'
          : intent.status === 'canceled'
            ? 'CANCELLED'
            : 'STARTED';

    return {
      paymentReference: charge.id,
      status,
      clientSecret:
        status === 'STARTED' && !current.cancellationRequestedAt
          ? intent.clientSecret
          : '',
    };
  }

  async cancel(request: CancelChargeRequest): Promise<CancelChargeResponse> {
    const charge = await this.charges.findByReference(
      request.paymentReference,
      request.bookingReference,
    );
    if (!charge) throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    return { status: await this.intents.cancelFor(charge) };
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
        amountPiastres: charge.refundAmountPiastres ?? charge.amountPiastres,
      };
    }
    if (charge.status !== 'succeeded') {
      return {
        status: 'NOT_REFUNDABLE',
        refundReference: '',
        amountPiastres: 0,
      };
    }

    if (
      !(await this.charges.refundSucceeded(charge.id, request.amountPiastres))
    ) {
      const current = await this.charges.findByReference(
        charge.id,
        charge.bookingReference,
      );
      if (current?.status === 'refunded') {
        return {
          status: 'ALREADY_REFUNDED',
          refundReference,
          amountPiastres:
            current.refundAmountPiastres ?? current.amountPiastres,
        };
      }
      return {
        status: 'NOT_REFUNDABLE',
        refundReference: '',
        amountPiastres: 0,
      };
    }

    return {
      status: 'REFUNDED',
      refundReference,
      amountPiastres: request.amountPiastres,
    };
  }
}
