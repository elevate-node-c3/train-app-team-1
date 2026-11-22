import { Module } from '@nestjs/common';
import { CardsModule } from '../cards/cards.module.js';
import { PaymentDoubleService } from './services/payment-double.service.js';
import { PaymentIntentService } from './services/payment-intent.service.js';
import { PaymentGrpcController } from './payment.grpc.controller.js';
import { ChargesPersistenceModule } from './charges-persistence.module.js';
import { PaymentRecoveryWorker } from './payment-recovery.worker.js';

@Module({
  imports: [CardsModule, ChargesPersistenceModule],
  controllers: [PaymentGrpcController],
  providers: [
    PaymentDoubleService,
    PaymentIntentService,
    PaymentRecoveryWorker,
  ],
})
export class ChargesModule {}
