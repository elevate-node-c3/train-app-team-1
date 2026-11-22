import { Controller, Get, Optional } from '@nestjs/common';
import { BookingFlowRepository } from './modules/flow/booking-flow.repository.js';

/** A charge this old without a settlement outcome is worth a human's attention. */
const CHARGED_WITHOUT_OUTCOME_THRESHOLD_SECONDS = 60;

@Controller('booking')
export class ServiceInfoController {
  constructor(@Optional() private readonly repository?: BookingFlowRepository) {}

  @Get()
  async getInfo(): Promise<{
    service: string;
    status: string;
    chargedWithoutOutcome: number;
  }> {
    const stuck = this.repository
      ? await this.repository.findChargedWithoutOutcome(
          CHARGED_WITHOUT_OUTCOME_THRESHOLD_SECONDS,
        )
      : [];
    return {
      service: 'booking',
      status: 'operational',
      chargedWithoutOutcome: stuck.length,
    };
  }
}
