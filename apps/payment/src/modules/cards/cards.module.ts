import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';
import { PaymentCustomerEntity } from './entities/payment-customer.entity.js';
import { SavedCardEntity } from './entities/saved-card.entity.js';
import { StripeService } from './services/stripe.service.js';
import { SavedCardsService } from './services/saved-cards.service.js';
import { SavedCardsGrpcController } from './controllers/saved-cards.grpc.controller.js';
import { StripeWebhookController } from './controllers/stripe-webhook.controller.js';
import { ChargeWebhookService } from '../charges/services/charge-webhook.service.js';
import { ChargesPersistenceModule } from '../charges/charges-persistence.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentCustomerEntity, SavedCardEntity]),
    OutboxModule,
    ChargesPersistenceModule,
  ],
  controllers: [SavedCardsGrpcController, StripeWebhookController],
  providers: [StripeService, SavedCardsService, ChargeWebhookService],
  exports: [SavedCardsService, StripeService, ChargeWebhookService],
})
export class CardsModule {}
