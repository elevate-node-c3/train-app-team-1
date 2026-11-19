import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { UseInterceptors } from '@nestjs/common';
import { GrpcCorrelationInterceptor, toRpcException } from '@app/common';
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
  async startCharge(request: StartChargeRequest): Promise<StartChargeResponse> {
    try {
      return await this.payment.start(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'CancelCharge')
  async cancelCharge(
    request: CancelChargeRequest,
  ): Promise<CancelChargeResponse> {
    try {
      return await this.payment.cancel(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
