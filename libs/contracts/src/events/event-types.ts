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
} as const;

export type EventTypeName = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
