import { Controller, Get } from '@nestjs/common';
import { PaymentService } from '../domain/payment.service.js';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return this.paymentService.getInfo();
  }
}
