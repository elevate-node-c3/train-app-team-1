import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardsModule } from '../cards/cards.module.js';
import { PaymentChargeEntity } from './entities/payment-charge.entity.js';
import { StripeEventEntity } from './entities/stripe-event.entity.js';
import { PaymentDoubleService } from './services/payment-double.service.js';
import { PaymentIntentService } from './services/payment-intent.service.js';
import { PaymentGrpcController } from './payment.grpc.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PaymentChargeEntity,
      StripeEventEntity,
    ]),
    CardsModule,
  ],
  controllers: [PaymentGrpcController],
  providers: [PaymentDoubleService, PaymentIntentService],
})
export class ChargesModule {}
