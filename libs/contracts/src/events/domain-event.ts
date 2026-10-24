/**
 * Envelope for every domain event published to the broker. Payloads never
 * carry passwords. A one-time code appears only in the event that delivers it
 * by email, and must never be logged.
 */

/** DI token for the DomainEventPublisher implementation. */
export const DOMAIN_EVENT_PUBLISHER = Symbol('DOMAIN_EVENT_PUBLISHER');

/** Topic exchange for all domain events; the routing key is the event type. */
export const DOMAIN_EVENTS_EXCHANGE = 'train.domain-events';

export const IdentityEventType = {
  TRAVELLER_SIGNED_IN: 'traveller.signed_in',
  ACCOUNT_LOCKED: 'account.locked',
  PASSWORD_RESET_CODE_ISSUED: 'password_reset_code.issued',
  PASSWORD_RESET: 'password.reset',
} as const;

export type IdentityEventType =
  (typeof IdentityEventType)[keyof typeof IdentityEventType];

export interface DomainEvent<TPayload = unknown> {
  /** UUID, unique per event; consumers use it to deduplicate. */
  eventId: string;
  type: string;
  /** Schema version of `payload`, bumped on breaking changes. */
  version: number;
  /** ISO-8601 UTC. */
  occurredAt: string;
  correlationId: string;
  payload: TPayload;
}

export interface DomainEventPublisher {
  /**
   * Publishes an event to the broker.
   * @returns resolves once the broker accepts it; rejects otherwise
   */
  publish<TPayload>(event: DomainEvent<TPayload>): Promise<void>;
}
