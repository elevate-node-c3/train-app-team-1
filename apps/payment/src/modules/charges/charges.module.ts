import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentChargeEntity } from './entities/payment-charge.entity.js';
import { PaymentDoubleService } from './payment-double.service.js';
import { PaymentGrpcController } from './payment.grpc.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([PaymentChargeEntity])],
  controllers: [PaymentGrpcController],
  providers: [PaymentDoubleService],
})
export class ChargesModule {}
