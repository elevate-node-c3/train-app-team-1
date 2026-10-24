import { Injectable } from '@nestjs/common';
import { PaymentRepository } from '../persistence/payment.repository.js';

@Injectable()
export class PaymentService {
  constructor(private readonly repository: PaymentRepository) {}

  getInfo(): { service: string; status: string } {
    return {
      service: 'payment',
      status: 'operational',
    };
  }
}
