import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import {
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_WITHDRAWN_EVENT_TYPE,
} from '@app/contracts';
import { AmqpClientService } from '@app/messaging/amqp-client.service.js';
import {
  consumerTopology,
  declareTopology,
} from '@app/messaging/amqp-topology.js';
import { retryDelaysFor } from '@app/messaging/consumer/consumer-config.js';
import { messageOf } from '@app/messaging/error-message.js';

/** Inventory owns this queue because it owns seat data. */
export const INVENTORY_TRIP_LIFECYCLE_QUEUE = 'inventory.trip-lifecycle';

/** One queue for a future handler to create and remove seats. */
export const TRIP_LIFECYCLE_EVENT_TYPES = [
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_WITHDRAWN_EVENT_TYPE,
] as const;

/** Declare durable queues early so trip events wait safely for a future consumer. */
@Injectable()
export class TripLifecycleTopologyService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TripLifecycleTopologyService.name);
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

      // Match retry queues to the future consumer's platform budget.
      const retryDelaysMs = retryDelaysFor({});

      // Bind each event type; repeated declarations are safe.
      for (const eventType of TRIP_LIFECYCLE_EVENT_TYPES) {
        await declareTopology(
          channel,
          consumerTopology({
            queue: INVENTORY_TRIP_LIFECYCLE_QUEUE,
            eventType,
            retryDelaysMs,
          }),
        );
      }

      this.logger.log(
        `Holding ${TRIP_LIFECYCLE_EVENT_TYPES.join(', ')} in ${INVENTORY_TRIP_LIFECYCLE_QUEUE}`,
      );
    } catch (error: unknown) {
      // Keep running; the next reconnect retries queue setup.
      this.logger.error(
        `Could not declare ${INVENTORY_TRIP_LIFECYCLE_QUEUE}: ${messageOf(error)}`,
      );
    }
  }
}
