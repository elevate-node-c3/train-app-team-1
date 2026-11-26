import type {
  BookingRefundedPayloadV1,
  BookingSeatsChangedPayloadV1,
} from '@app/contracts';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** The facts, not prose composed from codes: this is the edge for this copy. */
export function renderSeatsChangedEmail(
  payload: Pick<BookingSeatsChangedPayloadV1, 'bookingReference' | 'seats'>,
): EmailContent {
  const lines = payload.seats.map(
    (seat) => `Coach ${seat.coachNumber}, seat ${seat.seatNumber}`,
  );
  const text = [
    `Your seats for booking ${payload.bookingReference} changed.`,
    'Your new seats:',
    ...lines,
  ].join('\n');
  const html = `
    <div dir="ltr">
      <p>Your seats for booking <strong>${escapeHtml(payload.bookingReference)}</strong> changed.</p>
      <p>Your new seats:</p>
      <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    </div>
  `;
  return { subject: 'Your seats have changed', text, html };
}

export function renderBookingRefundedEmail(
  payload: Pick<BookingRefundedPayloadV1, 'bookingReference' | 'amountPiastres'>,
): EmailContent {
  const amountEgp = (payload.amountPiastres / 100).toFixed(2);
  const text = [
    `Booking ${payload.bookingReference} could not be confirmed.`,
    `You have been refunded ${amountEgp} EGP in full.`,
  ].join('\n');
  const html = `
    <div dir="ltr">
      <p>Booking <strong>${escapeHtml(payload.bookingReference)}</strong> could not be confirmed.</p>
      <p>You have been refunded <strong>${escapeHtml(amountEgp)} EGP</strong> in full.</p>
    </div>
  `;
  return { subject: 'Your booking was refunded in full', text, html };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
