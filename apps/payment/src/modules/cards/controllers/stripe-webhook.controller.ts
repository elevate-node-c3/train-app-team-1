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
import { StripeService } from '../services/stripe.service.js';
import { SavedCardsService } from '../services/saved-cards.service.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly savedCardsService: SavedCardsService,
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

    try {
      const event = this.stripeService.constructEvent(payload, signature);
      await this.savedCardsService.handleWebhookEvent(event);
      return { received: true };
    } catch (err: unknown) {
      this.logger.error(
        `Webhook signature verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new BadRequestException('Webhook signature verification failed');
    }
  }
}
