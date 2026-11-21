import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentCustomerEntity } from './entities/payment-customer.entity.js';
import { SavedCardEntity } from './entities/saved-card.entity.js';
import { StripeService } from './services/stripe.service.js';
import { SavedCardsService } from './services/saved-cards.service.js';
import { SavedCardsGrpcController } from './controllers/saved-cards.grpc.controller.js';
import { StripeWebhookController } from './controllers/stripe-webhook.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentCustomerEntity, SavedCardEntity]),
  ],
  controllers: [SavedCardsGrpcController, StripeWebhookController],
  providers: [StripeService, SavedCardsService],
  exports: [SavedCardsService, StripeService],
})
export class CardsModule {}
