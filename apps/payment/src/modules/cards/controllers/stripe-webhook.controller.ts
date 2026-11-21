import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { StripeService } from '../services/stripe.service.js';
import { SavedCardsService } from '../services/saved-cards.service.js';
import { ChargeWebhookService } from '../../charges/services/charge-webhook.service.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly savedCardsService: SavedCardsService,
    private readonly chargeWebhooks: ChargeWebhookService,
  ) {}

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: boolean }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    const payload = req.rawBody ?? (req.body as Buffer);
    if (!payload) {
      throw new BadRequestException('Missing request body');
    }

    let event: Stripe.Event;
    try {
      event = this.stripeService.constructEvent(payload, signature);
    } catch {
      this.logger.error('Webhook signature verification failed');
      throw new BadRequestException('Webhook signature verification failed');
    }

    if (event.type.startsWith('payment_intent.')) {
      // The charge inbox earns the 2xx; the saga decision happens after.
      await this.chargeWebhooks.record(event);
    } else {
      await this.savedCardsService.handleWebhookEvent(event);
    }
    return { received: true };
  }
}
