import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ErrorCode } from '@app/contracts';
import { StripeService } from '../../cards/services/stripe.service.js';
import { PaymentError } from '../payment-error.js';
import { ChargeCardRepository } from '../repositories/charge-card.repository.js';
import { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { Charge } from '../types/charge.types.js';
import type {
  PaymentIntentStartResult,
  PaymentIntentSnapshot,
} from '../types/payment-intent.types.js';
import { ChargeWebhookService } from './charge-webhook.service.js';

/**
 * Persist a creation claim before Stripe I/O. Ambiguous retries reuse the key
 * only within its safe window, then reconcile metadata without blind creation.
 */
@Injectable()
export class PaymentIntentService {
  private readonly logger = new Logger(PaymentIntentService.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly charges: PaymentChargeRepository,
    private readonly cards: ChargeCardRepository,
    private readonly webhooks: ChargeWebhookService,
  ) {}

  async startFor(charge: Charge): Promise<PaymentIntentStartResult> {
    const current = await this.current(charge);
    if (current.status !== 'started') {
      return {
        paymentIntentId: current.stripePaymentIntentId ?? '',
        clientSecret: '',
        status: current.status === 'cancelled' ? 'canceled' : current.status,
      };
    }
    const intent = await this.resolve(current);
    return {
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
      status: intent.status,
    };
  }

  async cancelFor(charge: Charge): Promise<'CANCELLED' | 'ALREADY_SUCCEEDED'> {
    await this.charges.requestCancellation(charge.id, charge.bookingReference);
    const current = await this.current(charge);
    if (current.status === 'succeeded') return 'ALREADY_SUCCEEDED';
    if (current.status === 'refunded' || current.status === 'cancelled')
      return 'CANCELLED';
    if (
      await this.charges.cancelUnattempted(current.id, current.bookingReference)
    )
      return 'CANCELLED';

    let intent = await this.resolve(current);
    if (intent.status === 'succeeded') return 'ALREADY_SUCCEEDED';
    if (intent.status !== 'canceled') {
      try {
        intent = await this.stripe.cancelPaymentIntent(
          intent.id,
          current.bookingReference,
        );
      } catch {
        // A browser confirmation can win while Stripe rejects the cancellation.
        // Retrieve the authoritative outcome rather than claiming cancellation.
        intent = await this.stripe.retrievePaymentIntent(intent.id);
      }
      intent = await this.observe(current, intent);
    }
    if (intent.status === 'succeeded') return 'ALREADY_SUCCEEDED';
    if (intent.status !== 'canceled')
      throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 3);
    await this.charges.cancelStarted(current.id, current.bookingReference);
    const final = await this.current(current);
    return final.status === 'succeeded' ? 'ALREADY_SUCCEEDED' : 'CANCELLED';
  }

  async recoverPending(limit = 50): Promise<void> {
    for (const charge of await this.charges.findRecoveryPending(limit)) {
      let error: string | null = null;
      try {
        if (charge.cancellationRequestedAt) await this.cancelFor(charge);
        else await this.startFor(charge);
      } catch (failure: unknown) {
        error =
          failure instanceof Error
            ? failure.message
            : 'Intent reconciliation failed';
        this.logger.error(
          `ALERT: payment ${charge.id} requires recovery: ${error}`,
        );
      }
      await this.charges.deferRecovery(charge.id, error);
    }
  }

  private async current(charge: Charge): Promise<Charge> {
    const current = await this.charges.findByReference(
      charge.id,
      charge.bookingReference,
    );
    if (!current) throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    return current;
  }

  private async resolve(charge: Charge): Promise<PaymentIntentSnapshot> {
    if (charge.stripePaymentIntentId) {
      return this.observe(
        charge,
        await this.stripe.retrievePaymentIntent(charge.stripePaymentIntentId),
      );
    }
    let customerId = charge.stripeCustomerId ?? '';
    if (charge.stripePaymentMethodId && !customerId) {
      customerId =
        (await this.cards.findCustomerIdByPaymentMethodId(
          charge.stripePaymentMethodId,
        )) ?? '';
      if (!customerId) throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    }
    const claim = randomUUID();
    const claimed = await this.charges.claimIntentCreation(
      charge.id,
      claim,
      customerId,
    );
    if (!claimed) {
      const current = await this.current(charge);
      if (current.stripePaymentIntentId) {
        return this.observe(
          current,
          await this.stripe.retrievePaymentIntent(
            current.stripePaymentIntentId,
          ),
        );
      }
      throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 3);
    }

    try {
      const age = Date.now() - claimed.intentCreationStartedAt!.getTime();
      let intent: PaymentIntentSnapshot | undefined;
      if (charge.intentCreationStartedAt || age >= 23 * 60 * 60 * 1_000) {
        const matches = await this.stripe.findPaymentIntentsForBooking(
          charge.bookingReference,
        );
        if (
          matches.length > 1 ||
          (matches[0] && matches[0].metadata.paymentReference !== charge.id)
        ) {
          throw new Error(
            'Stripe correlation is ambiguous; refusing a second intent',
          );
        }
        intent = matches[0];
      }
      if (!intent) {
        // Search is eventually consistent. An empty result after the safe key
        // window is not proof that the original request never reached Stripe.
        if (
          age >= 23 * 60 * 60 * 1_000 ||
          !(await this.charges.canReplayIntentCreation(charge.id, claim))
        ) {
          throw new Error(
            'Stripe idempotency window expired; orphan reconciliation required, creation refused',
          );
        }
        intent = await this.stripe.createOrRetrievePaymentIntent({
          bookingReference: charge.bookingReference,
          paymentReference: charge.id,
          amountPiastres: charge.amountPiastres,
          currency: charge.currency,
          customerId: claimed.stripeCustomerId ?? '',
          paymentMethodId: charge.stripePaymentMethodId ?? '',
          idempotencyKey: `booking:${charge.bookingReference}:charge`,
        });
      }
      await this.charges.completeIntentCreation(charge.id, claim, intent.id);
      return await this.observe(await this.current(charge), intent);
    } catch (error: unknown) {
      await this.charges.releaseIntentCreation(
        charge.id,
        claim,
        error instanceof Error
          ? error.message
          : 'Payment intent creation requires reconciliation',
      );
      if (error instanceof PaymentError) throw error;
      throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 3);
    }
  }

  private async observe(
    charge: Charge,
    intent: PaymentIntentSnapshot,
  ): Promise<PaymentIntentSnapshot> {
    await this.webhooks.recordVerifiedIntent(intent);
    if (
      (charge.stripePaymentIntentId &&
        intent.id !== charge.stripePaymentIntentId) ||
      intent.amount !== charge.amountPiastres ||
      intent.currency.toLowerCase() !== charge.currency.toLowerCase() ||
      (intent.status === 'succeeded' &&
        intent.amountReceived !== charge.amountPiastres)
    ) {
      this.logger.error(
        `ALERT: Stripe intent ${intent.id} does not match the locked amount/currency for ${charge.id}`,
      );
      throw new PaymentError(ErrorCode.CONFLICT);
    }
    if (intent.status === 'canceled')
      await this.charges.cancelStarted(charge.id, charge.bookingReference);
    const active = [
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
    ].includes(intent.status);
    if (active && !intent.clientSecret && !charge.cancellationRequestedAt) {
      throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 3);
    }
    return {
      ...intent,
      clientSecret:
        active && !charge.cancellationRequestedAt ? intent.clientSecret : '',
    };
  }
}
