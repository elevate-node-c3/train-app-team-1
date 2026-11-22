import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
import { StripeService } from '../../cards/services/stripe.service.js';
import { PaymentError } from '../payment-error.js';
import { ChargeCardRepository } from '../repositories/charge-card.repository.js';
import { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { Charge } from '../types/charge.types.js';
import type { PaymentIntentStartResult } from '../types/payment-intent.types.js';

/**
 * One Stripe PaymentIntent per booking. The idempotency key is derived from
 * the booking (`booking:{id}:charge`), never random, and the intent id is
 * persisted on the charge in the same write path, so a retry after a decline or
 * a restart returns the same intent instead of creating a second charge.
 */
@Injectable()
export class PaymentIntentService {
  constructor(
    private readonly stripe: StripeService,
    private readonly charges: PaymentChargeRepository,
    private readonly cards: ChargeCardRepository,
  ) {}

  async startFor(charge: Charge): Promise<PaymentIntentStartResult> {
    const idempotencyKey = `booking:${charge.bookingReference}:charge`;

    if (charge.stripePaymentIntentId) {
      const intent = await this.stripe.retrievePaymentIntent(
        charge.stripePaymentIntentId,
      );
      return {
        paymentIntentId: intent.id,
        clientSecret: intent.clientSecret,
        status: intent.status,
      };
    }

    let customerId = '';
    if (charge.stripePaymentMethodId) {
      customerId =
        (await this.cards.findCustomerIdByPaymentMethodId(
          charge.stripePaymentMethodId,
        )) ?? '';
      if (!customerId) {
        throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
      }
    }

    const intent = await this.stripe.createOrRetrievePaymentIntent({
      bookingReference: charge.bookingReference,
      amountPiastres: charge.amountPiastres,
      currency: charge.currency,
      customerId,
      paymentMethodId: charge.stripePaymentMethodId ?? '',
      idempotencyKey,
    });

    await this.charges.savePaymentIntent(charge.bookingReference, intent.id);

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
      status: intent.status,
    };
  }
}
