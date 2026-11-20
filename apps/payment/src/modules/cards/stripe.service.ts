import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';
import { DataSource } from 'typeorm';
import { ErrorCode } from '@app/contracts';
import { PaymentError } from '../charges/payment-error.js';
import {
  stripeSettingsFromEnv,
  type StripeSettings,
} from '../../config/stripe.settings.js';

const TIMEOUT_MS = 2000;
const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 30000;

enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly settings: StripeSettings;

  private circuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private nextAttempt = 0;

  constructor(private readonly dataSource: DataSource) {
    this.settings = stripeSettingsFromEnv();
    this.stripe = new Stripe(this.settings.secretKey || 'sk_test_placeholder', {
      apiVersion: '2026-11-18.endive',
    });
  }

  private async executeWithBreaker<T>(action: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.circuitState === CircuitState.OPEN) {
      if (now < this.nextAttempt) {
        throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 30);
      }
      this.circuitState = CircuitState.HALF_OPEN;
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Stripe call timed out'));
      }, TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([action(), timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
      this.onSuccess();
      return result;
    } catch (error: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      this.onFailure();
      this.logger.error(
        `Stripe call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 30);
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.circuitState = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount++;
    if (
      this.failureCount >= FAILURE_THRESHOLD ||
      this.circuitState === CircuitState.HALF_OPEN
    ) {
      this.circuitState = CircuitState.OPEN;
      this.nextAttempt = Date.now() + RESET_TIMEOUT_MS;
      this.logger.warn(
        `Stripe circuit breaker tripped OPEN until ${new Date(this.nextAttempt).toISOString()}`,
      );
    }
  }

  async getOrCreateCustomer(accountId: string): Promise<string> {
    const existing = await this.dataSource.query(
      'SELECT stripe_customer_id FROM payment_customer WHERE account_id = $1',
      [accountId],
    );
    if (existing[0]?.stripe_customer_id) {
      return existing[0].stripe_customer_id as string;
    }

    const idempotencyKey = `enr_cust_${createHash('sha256')
      .update(`customer:${accountId}`)
      .digest('hex')
      .slice(0, 32)}`;

    const stripeCustomer = await this.executeWithBreaker(async () => {
      return await this.stripe.customers.create(
        { metadata: { accountId } },
        { idempotencyKey },
      );
    });

    const inserted = await this.dataSource.query(
      `INSERT INTO payment_customer (id, account_id, stripe_customer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET account_id = EXCLUDED.account_id
       RETURNING stripe_customer_id`,
      [uuid(), accountId, stripeCustomer.id],
    );

    return inserted[0].stripe_customer_id as string;
  }

  async createSetupIntent(stripeCustomerId: string): Promise<{
    setupIntentId: string;
    clientSecret: string;
    publishableKey: string;
  }> {
    const setupIntent = await this.executeWithBreaker(async () => {
      return await this.stripe.setupIntents.create({
        customer: stripeCustomerId,
        usage: 'off_session',
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
      });
    });

    return {
      setupIntentId: setupIntent.id,
      clientSecret: setupIntent.client_secret ?? '',
      publishableKey: this.settings.publishableKey,
    };
  }

  async retrieveSetupIntent(setupIntentId: string): Promise<Stripe.SetupIntent> {
    return await this.executeWithBreaker(async () => {
      return await this.stripe.setupIntents.retrieve(setupIntentId, {
        expand: ['payment_method'],
      });
    });
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.executeWithBreaker(async () => {
      return await this.stripe.paymentMethods.detach(paymentMethodId);
    });
  }

  constructEvent(payload: Buffer | string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.settings.webhookSecret,
    );
  }
}
