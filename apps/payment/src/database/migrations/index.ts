import type { MigrationInterface } from 'typeorm';
import { CreatePaymentCharges1795000000001 } from './1795000000001-create-payment-charges.js';
import { CreateStripeCustomersAndSavedCards1796000000001 } from './1796000000001-create-stripe-customers-and-saved-cards.js';

export const migrations: (new () => MigrationInterface)[] = [
  CreatePaymentCharges1795000000001,
  CreateStripeCustomersAndSavedCards1796000000001,
];
