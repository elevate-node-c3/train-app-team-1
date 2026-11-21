import { Controller, UseInterceptors, UsePipes } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  createGrpcValidationPipe,
  GrpcCorrelationInterceptor,
  toRpcException,
} from '@app/common';
import {
  PAYMENT_SERVICE_NAME,
  type CancelChargeResponse,
  type StartChargeResponse,
} from '@app/contracts';
import {
  CancelChargeRequestDto,
  StartChargeRequestDto,
} from './dto/charge-request.dto.js';
import { PaymentDoubleService } from './services/payment-double.service.js';

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
@UsePipes(createGrpcValidationPipe())
export class PaymentGrpcController {
  constructor(private readonly payment: PaymentDoubleService) {}

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'StartCharge')
  async startCharge(
    request: StartChargeRequestDto,
  ): Promise<StartChargeResponse> {
    try {
      return await this.payment.start(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  @GrpcMethod(PAYMENT_SERVICE_NAME, 'CancelCharge')
  async cancelCharge(
    request: CancelChargeRequestDto,
  ): Promise<CancelChargeResponse> {
    try {
      return await this.payment.cancel(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
