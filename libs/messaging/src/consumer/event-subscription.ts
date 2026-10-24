import type { EventHandlerPort } from './event-handler.port.js';

export const EVENT_SUBSCRIPTIONS = Symbol('EVENT_SUBSCRIPTIONS');

/**
 * One consumer queue, one event contract, one handler. Several subscriptions
 * are independent queues: a slow or failing consumer never competes with
 * another service for the same message.
 */
export interface EventSubscription {
  eventType: string;
  /** The payload version this build understands; anything else dead-letters. */
  version: number;
  /** The consumer's own queue name. */
  queueName: string;
  handler: EventHandlerPort;
  /** Optional per-subscription override; defaults to the platform budget. */
  retryDelaysMs?: readonly number[];
}
