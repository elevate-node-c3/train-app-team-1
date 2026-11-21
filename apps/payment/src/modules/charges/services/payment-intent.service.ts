import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ChargeRow } from './payment-double.service.js';
import { StripeService } from '../../cards/services/stripe.service.js';

export interface PaymentIntentStartResult {
  paymentIntentId: string;
  clientSecret: string;
  status: string;
}

/**
 * One Stripe PaymentIntent per booking. The idempotency key is derived from
 * the booking (`booking:{id}:charge`), never random, and the intent id is
 * persisted on the charge in the same write path, so a retry after a decline or
 * a restart returns the same intent instead of creating a second charge.
 */
@Injectable()
export class PaymentIntentService {
  private readonly logger = new Logger(PaymentIntentService.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly dataSource: DataSource,
  ) {}

  async startFor(charge: ChargeRow): Promise<PaymentIntentStartResult> {
    const idempotencyKey = `booking:${charge.booking_reference}:charge`;

    if (charge.stripe_payment_intent_id) {
      const intent = await this.stripe.retrievePaymentIntent(
        charge.stripe_payment_intent_id,
      );
      return {
        paymentIntentId: intent.id,
        clientSecret: intent.clientSecret,
        status: intent.status,
      };
    }

    const intent = await this.stripe.createOrRetrievePaymentIntent({
      bookingReference: charge.booking_reference,
      amountPiastres: charge.amount_piastres,
      currency: charge.currency,
      customerId: charge.stripe_customer_id ?? '',
      paymentMethodId: charge.stripe_payment_method_id ?? '',
      idempotencyKey,
    });

    await this.dataSource.query(
      `UPDATE payment_charge SET stripe_payment_intent_id = $1, updated_at = NOW() WHERE booking_reference = $2`,
      [intent.id, charge.booking_reference],
    );

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
      status: intent.status,
    };
  }
}
