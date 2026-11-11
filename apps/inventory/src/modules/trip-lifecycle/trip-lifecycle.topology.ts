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

/** Inventory's own queue. It owns the trips' seats, so it owns their events. */
export const INVENTORY_TRIP_LIFECYCLE_QUEUE = 'inventory.trip-lifecycle';

/** One queue for both, because one handler creates and removes the seats. */
export const TRIP_LIFECYCLE_EVENT_TYPES = [
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_WITHDRAWN_EVENT_TYPE,
] as const;

/**
 * Declares the queue inventory will read, before it reads anything.
 *
 * Catalog publishes trips now (CAT-2) and the handler arrives in Sprint 3. A
 * message sent to an exchange with no queue bound to it is dropped, and the
 * relay marks it published, so without this the trips of the whole booking
 * window would be lost before their consumer existed.
 *
 * Declaring without consuming is the point: the queue holds the backlog, and
 * Sprint 3 adds an `EventConsumerService` subscription on the same name, which
 * re-asserts this topology and starts draining it.
 */
@Injectable()
export class TripLifecycleTopologyService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TripLifecycleTopologyService.name);
  private unsubscribeReconnect: (() => void) | null = null;

  constructor(private readonly amqp: AmqpClientService) {}

  async onApplicationBootstrap(): Promise<void> {
    // A replaced connection loses the channel, not the durable queue; but the
    // broker may itself have been replaced, so re-assert on reconnect.
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

      // Sprint 3's subscription must find the retry queues it would have
      // declared itself, so they are sized from the same platform budget.
      const retryDelaysMs = retryDelaysFor({});

      // Once per routing key: consumerTopology binds one event type, and every
      // assert is idempotent, so the second call only adds the second binding.
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
      // Degrade, don't crash: the next connection replacement retries. Trips
      // already in the queue are durable and wait regardless.
      this.logger.error(
        `Could not declare ${INVENTORY_TRIP_LIFECYCLE_QUEUE}: ${messageOf(error)}`,
      );
    }
  }
}
