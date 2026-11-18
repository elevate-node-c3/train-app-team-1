import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { UseInterceptors } from '@nestjs/common';
import { GrpcCorrelationInterceptor } from '@app/common';
import {
  PAYMENT_SERVICE_NAME,
  type CancelChargeRequest,
  type CancelChargeResponse,
  type StartChargeRequest,
  type StartChargeResponse,
} from '@app/contracts';
import { PaymentDoubleService } from './payment-double.service.js';

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class PaymentGrpcController {
  constructor(private readonly payment: PaymentDoubleService) {}

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'StartCharge')
  startCharge(request: StartChargeRequest): Promise<StartChargeResponse> {
    return this.payment.start(request);
  }

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'CancelCharge')
  cancelCharge(request: CancelChargeRequest): Promise<CancelChargeResponse> {
    return this.payment.cancel(request);
  }
}
