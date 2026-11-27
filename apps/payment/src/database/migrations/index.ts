import type { MigrationInterface } from 'typeorm';
import { CreatePaymentOutboxAndStripeEvent1797000000001 } from './1797000000001-create-payment-outbox-and-stripe-event.js';
import { CreatePaymentCharges1795000000001 } from './1795000000001-create-payment-charges.js';
import { CreateStripeCustomersAndSavedCards1796000000001 } from './1796000000001-create-stripe-customers-and-saved-cards.js';
import { PaymentChargeRecovery1797400000001 } from './1797400000001-payment-charge-recovery.js';
import { AddPaymentChargeRefundAmount1797600000002 } from './1797600000002-add-payment-charge-refund-amount.js';
import { CreatePaymentProcessedEvent1797700000001 } from './1797700000001-create-payment-processed-event.js';

export const migrations: (new () => MigrationInterface)[] = [
  CreatePaymentCharges1795000000001,
  CreateStripeCustomersAndSavedCards1796000000001,
  CreatePaymentOutboxAndStripeEvent1797000000001,
  PaymentChargeRecovery1797400000001,
  AddPaymentChargeRefundAmount1797600000002,
  CreatePaymentProcessedEvent1797700000001,
];
