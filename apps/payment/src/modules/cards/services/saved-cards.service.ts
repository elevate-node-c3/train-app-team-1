import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import type Stripe from 'stripe';
import { ErrorCode, type SavedCardItem } from '@app/contracts';
import { PaymentError } from '../../charges/payment-error.js';
import { StripeService } from './stripe.service.js';

interface SavedCardRow {
  id: string;
  account_id: string;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  cardholder_name: string;
  fingerprint: string;
  status: 'active' | 'detached';
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class SavedCardsService {
  private readonly logger = new Logger(SavedCardsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stripeService: StripeService,
  ) {}

  async createSetupIntent(accountId: string): Promise<{
    setupIntentId: string;
    clientSecret: string;
    publishableKey: string;
  }> {
    const customerId = await this.stripeService.getOrCreateCustomer(accountId);
    return await this.stripeService.createSetupIntent(customerId);
  }

  async confirmSetup(
    accountId: string,
    setupIntentId: string,
  ): Promise<SavedCardItem> {
    const setupIntent =
      await this.stripeService.retrieveSetupIntent(setupIntentId);

    if (setupIntent.status !== 'succeeded') {
      throw new PaymentError(ErrorCode.INVALID_PAYLOAD);
    }

    const customerRow = (await this.dataSource.query(
      'SELECT stripe_customer_id FROM payment_customer WHERE account_id = $1',
      [accountId],
    )) as Array<{ stripe_customer_id: string }>;

    const expectedCustomerId = customerRow[0]?.stripe_customer_id;
    const intentCustomerId =
      typeof setupIntent.customer === 'string'
        ? setupIntent.customer
        : setupIntent.customer?.id;

    if (!expectedCustomerId || expectedCustomerId !== intentCustomerId) {
      throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    }

    let paymentMethod: Stripe.PaymentMethod | undefined;
    if (
      setupIntent.payment_method &&
      typeof setupIntent.payment_method === 'object'
    ) {
      paymentMethod = setupIntent.payment_method as Stripe.PaymentMethod;
    }

    if (!paymentMethod || !paymentMethod.card) {
      throw new PaymentError(ErrorCode.INVALID_PAYLOAD);
    }

    const card = await this.recordCardFromStripe(
      accountId,
      expectedCustomerId,
      paymentMethod,
    );

    return this.toSavedCardItem(card, true);
  }

  async recordCardFromStripe(
    accountId: string,
    stripeCustomerId: string,
    paymentMethod: Stripe.PaymentMethod,
  ): Promise<SavedCardRow> {
    const cardData = paymentMethod.card;
    if (!cardData) {
      throw new PaymentError(ErrorCode.INVALID_PAYLOAD);
    }

    const brand = cardData.brand;
    const last4 = cardData.last4;
    const expMonth = cardData.exp_month;
    const expYear = cardData.exp_year;
    const fingerprint = cardData.fingerprint ?? '';
    const rawName = paymentMethod.billing_details?.name?.trim();
    const cardholderName = rawName
      ? `${rawName} ****${last4}`
      : `Cardholder ****${last4}`;

    // Check for duplicate card (same fingerprint for this account)
    const existing = (await this.dataSource.query(
      `SELECT * FROM saved_card
       WHERE account_id = $1 AND fingerprint = $2 AND status = 'active'`,
      [accountId, fingerprint],
    )) as SavedCardRow[];

    if (existing[0]) {
      // Quiet success: return existing card without creating duplicate row
      if (existing[0].stripe_payment_method_id !== paymentMethod.id) {
        try {
          await this.stripeService.detachPaymentMethod(paymentMethod.id);
        } catch {
          // Detach failure is non-fatal for idempotent return
        }
      }
      return existing[0];
    }

    const cardId = uuid();
    await this.dataSource.query(
      `INSERT INTO saved_card
         (id, account_id, stripe_customer_id, stripe_payment_method_id,
          brand, last4, exp_month, exp_year, cardholder_name, fingerprint, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       ON CONFLICT (stripe_payment_method_id) DO NOTHING`,
      [
        cardId,
        accountId,
        stripeCustomerId,
        paymentMethod.id,
        brand,
        last4,
        expMonth,
        expYear,
        cardholderName,
        fingerprint,
      ],
    );

    const inserted = (await this.dataSource.query(
      'SELECT * FROM saved_card WHERE stripe_payment_method_id = $1',
      [paymentMethod.id],
    )) as SavedCardRow[];

    return inserted[0]!;
  }

  async listCards(accountId: string): Promise<SavedCardItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT * FROM saved_card
       WHERE account_id = $1 AND status = 'active'
       ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
      [accountId],
    )) as SavedCardRow[];

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    let defaultAssigned = false;
    const cards: SavedCardItem[] = [];

    for (const row of rows) {
      const isExpired =
        row.exp_year < currentYear ||
        (row.exp_year === currentYear && row.exp_month < currentMonth);
      const canPay = !isExpired;

      let isDefault = false;
      if (canPay && !defaultAssigned) {
        isDefault = true;
        defaultAssigned = true;
      }

      cards.push({
        id: row.id,
        brand: row.brand,
        last4: row.last4,
        expMonth: row.exp_month,
        expYear: row.exp_year,
        cardholderName: row.cardholder_name,
        isDefault,
        canPay,
        isExpired,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at),
      });
    }

    return cards;
  }

  async deleteCard(accountId: string, cardId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT * FROM saved_card
       WHERE id = $1 AND account_id = $2 AND status = 'active'`,
      [cardId, accountId],
    )) as SavedCardRow[];

    const card = rows[0];
    if (!card) {
      throw new PaymentError(ErrorCode.RESOURCE_NOT_FOUND);
    }

    await this.stripeService.detachPaymentMethod(card.stripe_payment_method_id);

    await this.dataSource.query(
      `UPDATE saved_card
       SET status = 'detached', updated_at = NOW()
       WHERE id = $1`,
      [card.id],
    );

    return true;
  }

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    if (event.type === 'setup_intent.succeeded') {
      const setupIntent = event.data.object as Stripe.SetupIntent;
      const stripeCustomerId =
        typeof setupIntent.customer === 'string'
          ? setupIntent.customer
          : setupIntent.customer?.id;

      if (!stripeCustomerId) return;

      const customerRows = (await this.dataSource.query(
        'SELECT account_id FROM payment_customer WHERE stripe_customer_id = $1',
        [stripeCustomerId],
      )) as Array<{ account_id: string }>;

      const customer = customerRows[0];
      if (!customer) {
        this.logger.warn(
          `Webhook received for unknown Stripe customer: ${stripeCustomerId}`,
        );
        return;
      }

      const paymentMethodId =
        typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id;

      if (!paymentMethodId) return;

      const fullIntent = await this.stripeService.retrieveSetupIntent(
        setupIntent.id,
      );
      if (
        fullIntent.payment_method &&
        typeof fullIntent.payment_method === 'object'
      ) {
        await this.recordCardFromStripe(
          customer.account_id,
          stripeCustomerId,
          fullIntent.payment_method as Stripe.PaymentMethod,
        );
      }
    }
  }

  private toSavedCardItem(
    row: SavedCardRow,
    isDefault = false,
  ): SavedCardItem {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const isExpired =
      row.exp_year < currentYear ||
      (row.exp_year === currentYear && row.exp_month < currentMonth);

    return {
      id: row.id,
      brand: row.brand,
      last4: row.last4,
      expMonth: row.exp_month,
      expYear: row.exp_year,
      cardholderName: row.cardholder_name,
      isDefault: isDefault && !isExpired,
      canPay: !isExpired,
      isExpired,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
  }
}
