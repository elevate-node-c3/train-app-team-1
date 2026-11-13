import type { EventHandlerPort } from './event-handler.port.js';

export const EVENT_SUBSCRIPTIONS = Symbol('EVENT_SUBSCRIPTIONS');

/** Each consumer owns one queue and handler so services never compete for the same copy. */
export interface EventSubscription {
  eventType: string;
  /** Unsupported payload versions are dead-lettered. */
  version: number;
  /** The consumer's own queue name. */
  queueName: string;
  handler: EventHandlerPort;
  /** Optional override; defaults to the platform retry budget. */
  retryDelaysMs?: readonly number[];
}
