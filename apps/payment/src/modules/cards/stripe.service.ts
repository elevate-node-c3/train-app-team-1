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
  private stripe?: Stripe;
  private readonly settings: StripeSettings;

  private circuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private nextAttempt = 0;

  constructor(private readonly dataSource: DataSource) {
    this.settings = stripeSettingsFromEnv();
  }

  private get stripeClient(): Stripe {
    if (!this.stripe) {
      if (!this.settings.secretKey) {
        throw new Error(
          "Missing required environment variable 'STRIPE_SECRET_KEY'",
        );
      }
      this.stripe = new Stripe(this.settings.secretKey, {
        apiVersion: '2026-11-18.endive',
      });
    }
    return this.stripe;
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
    } catch {
      if (timeoutId) clearTimeout(timeoutId);
      this.onFailure();
      this.logger.error('Stripe call failed');
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
    const idempotencyKey = `enr_cust_${createHash('sha256')
      .update(`customer:${accountId}`)
      .digest('hex')
      .slice(0, 32)}`;

    return await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        accountId,
      ]);

      const existing = (await manager.query(
        'SELECT stripe_customer_id FROM payment_customer WHERE account_id = $1',
        [accountId],
      )) as Array<{ stripe_customer_id: string }>;
      if (existing[0]?.stripe_customer_id) {
        return existing[0].stripe_customer_id;
      }

      const stripeCustomer = await this.executeWithBreaker(async () => {
        return await this.stripeClient.customers.create(
          { metadata: { accountId } },
          { idempotencyKey },
        );
      });

      const inserted = (await manager.query(
        `INSERT INTO payment_customer (id, account_id, stripe_customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET account_id = EXCLUDED.account_id
         RETURNING stripe_customer_id`,
        [uuid(), accountId, stripeCustomer.id],
      )) as Array<{ stripe_customer_id: string }>;

      return inserted[0].stripe_customer_id;
    });
  }

  async createSetupIntent(stripeCustomerId: string): Promise<{
    setupIntentId: string;
    clientSecret: string;
    publishableKey: string;
  }> {
    const setupIntent = await this.executeWithBreaker(async () => {
      return await this.stripeClient.setupIntents.create({
        customer: stripeCustomerId,
        usage: 'off_session',
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
      });
    });

    if (!setupIntent.client_secret) {
      throw new PaymentError(ErrorCode.DEPENDENCY_UNAVAILABLE, 30);
    }

    return {
      setupIntentId: setupIntent.id,
      clientSecret: setupIntent.client_secret,
      publishableKey: this.settings.publishableKey,
    };
  }

  async retrieveSetupIntent(
    setupIntentId: string,
  ): Promise<Stripe.SetupIntent> {
    return await this.executeWithBreaker(async () => {
      return await this.stripeClient.setupIntents.retrieve(setupIntentId, {
        expand: ['payment_method'],
      });
    });
  }

  async detachPaymentMethod(
    paymentMethodId: string,
    stripeCustomerId: string,
  ): Promise<void> {
    const paymentMethod = await this.executeWithBreaker(async () => {
      return await this.stripeClient.paymentMethods.retrieve(paymentMethodId);
    });
    const currentCustomerId =
      typeof paymentMethod.customer === 'string'
        ? paymentMethod.customer
        : paymentMethod.customer?.id;
    if (!currentCustomerId) return;
    if (currentCustomerId !== stripeCustomerId) {
      throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    }

    await this.executeWithBreaker(async () => {
      return await this.stripeClient.paymentMethods.detach(paymentMethodId);
    });
  }

  constructEvent(payload: Buffer | string, signature: string): Stripe.Event {
    return this.stripeClient.webhooks.constructEvent(
      payload,
      signature,
      this.settings.webhookSecret,
    );
  }
}
