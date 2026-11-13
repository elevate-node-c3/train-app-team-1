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

/** Inventory owns these queues because it owns seat data. */
export const INVENTORY_TRIP_PUBLISHED_QUEUE =
  'inventory.trip-lifecycle.trip-published';
export const INVENTORY_TRIP_WITHDRAWN_QUEUE =
  'inventory.trip-lifecycle.trip-withdrawn';

export const INVENTORY_TRIP_LIFECYCLE_QUEUES = [
  INVENTORY_TRIP_PUBLISHED_QUEUE,
  INVENTORY_TRIP_WITHDRAWN_QUEUE,
] as const;

/**
 * One queue per event type: parseEventEnvelope rejects any delivery whose
 * type differs from its subscription's, so two subscriptions sharing a queue
 * each dead-letter the half that isn't theirs (catalog measured two of eight
 * handled). The old shared `inventory.trip-lifecycle` queue is unreachable by
 * these subscriptions now; `docker compose down -v` clears it since there is
 * no deployed environment to drain.
 */
const QUEUES_BY_EVENT_TYPE = [
  { queue: INVENTORY_TRIP_PUBLISHED_QUEUE, eventType: TRIP_PUBLISHED_EVENT_TYPE },
  { queue: INVENTORY_TRIP_WITHDRAWN_QUEUE, eventType: TRIP_WITHDRAWN_EVENT_TYPE },
] as const;

export const TRIP_LIFECYCLE_EVENT_TYPES = QUEUES_BY_EVENT_TYPE.map(
  (pair) => pair.eventType,
) as [typeof TRIP_PUBLISHED_EVENT_TYPE, typeof TRIP_WITHDRAWN_EVENT_TYPE];

/** Declare durable queues early so trip events wait safely for the consumer. */
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

      // Match retry queues to the consumer's platform budget.
      const retryDelaysMs = retryDelaysFor({});

      // One queue per event type; repeated declarations are safe.
      for (const { queue, eventType } of QUEUES_BY_EVENT_TYPE) {
        await declareTopology(
          channel,
          consumerTopology({
            queue,
            eventType,
            retryDelaysMs,
          }),
        );
      }

      this.logger.log(`Declared ${INVENTORY_TRIP_LIFECYCLE_QUEUES.join(', ')}`);
    } catch (error: unknown) {
      // Keep running; the next reconnect retries queue setup.
      this.logger.error(
        `Could not declare trip-lifecycle queues: ${messageOf(error)}`,
      );
    }
  }
}
