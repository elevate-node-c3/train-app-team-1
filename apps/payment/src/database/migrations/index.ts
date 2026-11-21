import type { MigrationInterface } from 'typeorm';
import { CreatePaymentOutboxAndStripeEvent1797000000001 } from './1797000000001-create-payment-outbox-and-stripe-event.js';
import { CreatePaymentCharges1795000000001 } from './1795000000001-create-payment-charges.js';
import { CreateStripeCustomersAndSavedCards1796000000001 } from './1796000000001-create-stripe-customers-and-saved-cards.js';

export const migrations: (new () => MigrationInterface)[] = [
  CreatePaymentCharges1795000000001,
  CreateStripeCustomersAndSavedCards1796000000001,
  CreatePaymentOutboxAndStripeEvent1797000000001,
];
