/**
 * Routing keys are producer.aggregate.action, without versions.
 * Breaking changes need new keys so old and new consumers can coexist.
 */
export const EVENT_TYPES = {
  verificationCodeIssued: 'identity.verification-code.issued',
  accountRegistered: 'identity.account.registered',
  emailVerified: 'identity.email.verified',
  sessionRevoked: 'identity.session.revoked',
  passwordReset: 'identity.password.reset',
  profileCompleted: 'identity.profile.completed',
  timetablePublished: 'catalog.timetable.published',
  fareChanged: 'catalog.fare.changed',
  stationChanged: 'catalog.station.changed',
  tripPublished: 'catalog.trip.published',
  tripWithdrawn: 'catalog.trip.withdrawn',
  seatAvailabilityChanged: 'inventory.seat.availability-changed',
  tripSeatsCreated: 'inventory.trip.seats-created',
  tripPublicationRefused: 'inventory.trip.publication-refused',
  holdHeld: 'inventory.hold.held',
  holdReleased: 'inventory.hold.released',
  holdExpired: 'inventory.hold.expired',
  holdExtended: 'inventory.hold.extended',
  bookingAwaitingPayment: 'booking.awaiting-payment',
  bookingExpired: 'booking.expired-before-payment',
  /** Reconciliation (Sprint 5) and the drop-off KPI read this. */
  bookingAbandoned: 'booking.abandoned',
  bookingConfirmed: 'booking.confirmed',
  bookingSeatsChanged: 'booking.seats-changed',
  bookingRefunded: 'booking.refunded',
  ticketCancelled: 'ticket.cancelled',
  paymentSucceeded: 'payment.charge.succeeded',
  paymentFailed: 'payment.charge.failed',
} as const;

export type EventTypeName = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
