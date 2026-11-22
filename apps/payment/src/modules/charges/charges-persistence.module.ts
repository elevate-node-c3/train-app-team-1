import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedCardEntity } from '../cards/entities/saved-card.entity.js';
import { PaymentChargeEntity } from './entities/payment-charge.entity.js';
import { StripeEventEntity } from './entities/stripe-event.entity.js';
import { ChargeCardRepository } from './repositories/charge-card.repository.js';
import { PaymentChargeRepository } from './repositories/payment-charge.repository.js';
import { StripeEventRepository } from './repositories/stripe-event.repository.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PaymentChargeEntity,
      StripeEventEntity,
      SavedCardEntity,
    ]),
  ],
  providers: [
    ChargeCardRepository,
    PaymentChargeRepository,
    StripeEventRepository,
  ],
  exports: [
    ChargeCardRepository,
    PaymentChargeRepository,
    StripeEventRepository,
  ],
})
export class ChargesPersistenceModule {}
