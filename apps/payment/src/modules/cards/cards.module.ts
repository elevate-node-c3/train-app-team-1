import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentCustomerEntity } from './entities/payment-customer.entity.js';
import { SavedCardEntity } from './entities/saved-card.entity.js';
import { StripeService } from './stripe.service.js';
import { SavedCardsService } from './saved-cards.service.js';
import { SavedCardsGrpcController } from './saved-cards.grpc.controller.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentCustomerEntity, SavedCardEntity]),
  ],
  controllers: [SavedCardsGrpcController, StripeWebhookController],
  providers: [StripeService, SavedCardsService],
  exports: [SavedCardsService, StripeService],
})
export class CardsModule {}
