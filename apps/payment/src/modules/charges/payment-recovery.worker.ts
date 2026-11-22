import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';
import { ChargeWebhookService } from './services/charge-webhook.service.js';
import { PaymentIntentService } from './services/payment-intent.service.js';
import { StripeEventRepository } from './repositories/stripe-event.repository.js';
import { paymentRecoveryEnabled } from '../../config/env.schema.js';

/** Database locks and durable retry deadlines, not timers, own the work. */
@Injectable()
export class PaymentRecoveryWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PaymentRecoveryWorker.name);
  private running: Promise<void> | undefined;
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly webhooks: ChargeWebhookService,
    private readonly intents: PaymentIntentService,
    private readonly events: StripeEventRepository,
    private readonly schema: SchemaReadinessGate,
  ) {}

  onApplicationBootstrap(): void {
    if (paymentRecoveryEnabled()) this.running = this.loop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.running;
  }

  async scan(): Promise<void> {
    await this.webhooks.processPending();
    await this.intents.recoverPending();
    await this.webhooks.processPending();
    const { rejectedStripeEvents } = await this.events.recoveryCounts();
    if (rejectedStripeEvents) {
      this.logger.error(
        `ALERT: ${rejectedStripeEvents} verified Stripe events require amount/currency investigation`,
      );
    }
  }

  private async loop(): Promise<void> {
    await this.schema.whenReady;
    while (!this.stopping) {
      try {
        await this.scan();
      } catch (error: unknown) {
        this.logger.error(
          `Payment recovery scan failed: ${error instanceof Error ? error.message : 'unknown failure'}`,
        );
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, 2_000);
        this.timer.unref();
      });
      this.wake = undefined;
      this.timer = undefined;
    }
  }
}
