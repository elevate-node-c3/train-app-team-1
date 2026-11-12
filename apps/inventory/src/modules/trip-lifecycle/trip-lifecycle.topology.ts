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

/** Inventory owns the seats, so it owns their events. */
export const INVENTORY_TRIP_LIFECYCLE_QUEUE = 'inventory.trip-lifecycle';

/** One queue for both: one handler creates and removes the seats. */
export const TRIP_LIFECYCLE_EVENT_TYPES = [
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_WITHDRAWN_EVENT_TYPE,
] as const;

/**
 * Declares inventory's trip-lifecycle queue before anything reads it. Messages
 * with no bound queue are dropped, so this holds the booking-window backlog
 * until Sprint 3 adds the consumer.
 */
@Injectable()
export class TripLifecycleTopologyService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TripLifecycleTopologyService.name);
  private unsubscribeReconnect: (() => void) | null = null;

  constructor(private readonly amqp: AmqpClientService) {}

  async onApplicationBootstrap(): Promise<void> {
    // A new connection loses the channel, not the durable queue; re-assert on reconnect.
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

      // Sprint 3's consumer must find these retry queues; size them from the platform budget.
      const retryDelaysMs = retryDelaysFor({});

      // One event type per binding; asserts are idempotent.
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
      // Degrade, don't crash: the next reconnect retries; queued trips are durable.
      this.logger.error(
        `Could not declare ${INVENTORY_TRIP_LIFECYCLE_QUEUE}: ${messageOf(error)}`,
      );
    }
  }
}
