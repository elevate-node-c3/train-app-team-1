import type {
  BookingRefundedPayloadV1,
  BookingSeatsChangedPayloadV1,
  SupportedLanguage,
  TicketCancelledPayloadV1,
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

const COPY: Readonly<
  Record<
    SupportedLanguage,
    {
      subject: (code: string) => string;
      intro: (code: string) => string;
      seat: string;
      coach: string;
      seatLabel: string;
      refund: string;
    }
  >
> = {
  en: {
    subject: (code) => `Your ticket for booking ${code} was cancelled`,
    intro: (code) =>
      `Your ticket for booking ${code} has been cancelled and a refund has been requested.`,
    seat: 'Seat',
    coach: 'Coach',
    seatLabel: 'seat',
    refund: 'Refund requested',
  },
  ar: {
    subject: (code) => 'هذه التذكرة ملغاة بالفعل',
    intro: (code) => 'هذه التذكرة ملغاة بالفعل',
    seat: 'هذه التذكرة ملغاة بالفعل',
    coach: 'هذه التذكرة ملغاة بالفعل',
    seatLabel: 'هذه التذكرة ملغاة بالفعل',
    refund: 'هذه التذكرة ملغاة بالفعل',
  },
};

export function renderTicketCancelledEmail(
  payload: TicketCancelledPayloadV1,
  language: SupportedLanguage,
): EmailContent {
  const amountEgp = (payload.refundPiastres / 100).toFixed(2);
  const copy = COPY[language];
  const text = [
    copy.intro(payload.bookingReference),
    '',
    `${copy.seat}: ${copy.coach} ${payload.coachNumber}, ${copy.seatLabel} ${payload.seatNumber}`,
    `${copy.refund}: ${amountEgp} EGP`,
  ].join('\n');
  const html = `
    <div dir="${language === 'ar' ? 'rtl' : 'ltr'}" lang="${language}" style="text-align:${language === 'ar' ? 'right' : 'left'};font-family:Arial,Tahoma,sans-serif">
      <p>${escapeHtml(copy.intro(payload.bookingReference))}</p>
      <p>${escapeHtml(copy.seat)}: ${escapeHtml(copy.coach)} ${payload.coachNumber}, ${escapeHtml(copy.seatLabel)} ${escapeHtml(payload.seatNumber)}</p>
      <p>${escapeHtml(copy.refund)}: <strong>${escapeHtml(amountEgp)} EGP</strong></p>
    </div>
  `;
  return { subject: copy.subject(payload.bookingReference), text, html };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
