import { Controller, Get } from '@nestjs/common';
import { ChargeWebhookService } from './modules/charges/services/charge-webhook.service.js';

@Controller('payment')
export class ServiceInfoController {
  constructor(private readonly webhooks: ChargeWebhookService) {}

  @Get()
  async getInfo(): Promise<{
    service: string;
    status: string;
    pendingStripeEvents: number;
    rejectedStripeEvents: number;
    intentRecoveryProblems: number;
  }> {
    const recovery = (await this.webhooks?.recoveryInfo()) ?? {
      pendingStripeEvents: 0,
      rejectedStripeEvents: 0,
      intentRecoveryProblems: 0,
    };
    return {
      service: 'payment',
      status: 'operational',
      ...recovery,
    };
  }
}
