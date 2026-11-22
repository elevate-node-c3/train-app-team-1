import type { SavedCardEntity } from '../../cards/entities/saved-card.entity.js';
import type { PaymentChargeEntity } from '../entities/payment-charge.entity.js';

export type Charge = Pick<
  PaymentChargeEntity,
  | 'id'
  | 'bookingReference'
  | 'idempotencyKey'
  | 'amountPiastres'
  | 'currency'
  | 'status'
  | 'stripePaymentMethodId'
  | 'stripePaymentIntentId'
>;

export type ChargeCard = Pick<
  SavedCardEntity,
  | 'stripePaymentMethodId'
  | 'brand'
  | 'last4'
  | 'expMonth'
  | 'expYear'
  | 'status'
>;

export type CreateChargeInput = Pick<
  PaymentChargeEntity,
  | 'id'
  | 'bookingReference'
  | 'idempotencyKey'
  | 'amountPiastres'
  | 'currency'
  | 'cardBrand'
  | 'cardLast4'
  | 'stripePaymentMethodId'
>;
