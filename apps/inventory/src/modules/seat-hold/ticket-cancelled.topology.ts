import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { TICKET_CANCELLED_EVENT_TYPE } from '@app/contracts';
import { AmqpClientService } from '@app/messaging/amqp-client.service.js';
import {
  consumerTopology,
  declareTopology,
} from '@app/messaging/amqp-topology.js';
import { retryDelaysFor } from '@app/messaging/consumer/consumer-config.js';
import { messageOf } from '@app/messaging/error-message.js';

/** Inventory owns this queue because it owns seat occupation. */
export const INVENTORY_TICKET_CANCELLED_QUEUE = 'inventory.ticket-cancelled';

const QUEUES_BY_EVENT_TYPE = [
  {
    queue: INVENTORY_TICKET_CANCELLED_QUEUE,
    eventType: TICKET_CANCELLED_EVENT_TYPE,
  },
] as const;

/** Declare the durable queue early so cancellation events wait safely. */
@Injectable()
export class TicketCancelledTopologyService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TicketCancelledTopologyService.name);
  private unsubscribeReconnect: (() => void) | null = null;

  constructor(private readonly amqp: AmqpClientService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Reassert durable queues on each new channel.
    this.unsubscribeReconnect = this.amqp.onReconnect(() => this.declare());
    await this.declare();
  }

  beforeApplicationShutdown(): void {
    this.unsubscribeReconnect?.();
    this.unsubscribeReconnect = null;
  }

  async declare(): Promise<void> {
    try {
      const channel = await this.amqp.ensureChannel();
      const retryDelaysMs = retryDelaysFor({});

      for (const { queue, eventType } of QUEUES_BY_EVENT_TYPE) {
        await declareTopology(
          channel,
          consumerTopology({ queue, eventType, retryDelaysMs }),
        );
      }

      this.logger.log(`Declared ${INVENTORY_TICKET_CANCELLED_QUEUE}`);
    } catch (error: unknown) {
      // Keep running; the next reconnect retries queue setup.
      this.logger.error(
        `Could not declare ticket-cancelled queue: ${messageOf(error)}`,
      );
    }
  }
}
