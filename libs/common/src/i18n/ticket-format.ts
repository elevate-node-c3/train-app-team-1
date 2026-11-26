import type { SupportedLanguage } from '@app/contracts';

/**
 * How a printed ticket and its confirmation email spell dates, times,
 * durations and money. Shared so the PDF and the email never disagree.
 *
 * Inputs are Cairo civil values (`localDate`, `localTime`) that are printed
 * verbatim (BR-17): they are rebuilt as UTC instants and formatted in UTC, so
 * neither the host's zone nor DST can move them.
 *
 * Latin digits in both languages, to match the train, coach and seat numbers
 * printed beside them.
 */
const LOCALE: Readonly<Record<SupportedLanguage, string>> = {
  en: 'en-GB',
  ar: 'ar-EG-u-nu-latn',
};

const TIME_LOCALE: Readonly<Record<SupportedLanguage, string>> = {
  en: 'en-US',
  ar: 'ar-EG-u-nu-latn',
};

export interface TicketLabels {
  title: string;
  ticketNumber: string;
  bookingCode: string;
  passenger: string;
  train: string;
  travelClass: string;
  coach: string;
  seat: string;
  departure: string;
  arrival: string;
  duration: string;
  fare: string;
  qrCaption: string;
}

/** The words a printed ticket and its email use for each field. */
export const TICKET_LABELS: Readonly<Record<SupportedLanguage, TicketLabels>> =
  {
    en: {
      title: 'Train Ticket',
      ticketNumber: 'Ticket number',
      bookingCode: 'Booking code',
      passenger: 'Passenger',
      train: 'Train',
      travelClass: 'Class',
      coach: 'Coach',
      seat: 'Seat',
      departure: 'Departure',
      arrival: 'Arrival',
      duration: 'Duration',
      fare: 'Fare',
      qrCaption: 'Show this code to the conductor',
    },
    ar: {
      title: 'تذكرة قطار',
      ticketNumber: 'رقم التذكرة',
      bookingCode: 'رمز الحجز',
      passenger: 'المسافر',
      train: 'القطار',
      travelClass: 'الدرجة',
      coach: 'العربة',
      seat: 'المقعد',
      departure: 'المغادرة',
      arrival: 'الوصول',
      duration: 'مدة الرحلة',
      fare: 'السعر',
      qrCaption: 'اعرض هذا الرمز على مفتش القطار',
    },
  };

/** '2025-10-27' → '27 Oct, 2025' / '27 أكتوبر 2025'. */
export function formatTicketDate(
  localDate: string,
  language: SupportedLanguage,
): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const parts = new Intl.DateTimeFormat(LOCALE[language], {
    timeZone: 'UTC',
    day: 'numeric',
    month: language === 'ar' ? 'long' : 'short',
    year: 'numeric',
  }).formatToParts(new Date(Date.UTC(year, month - 1, day)));
  const part = (type: string): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return language === 'ar'
    ? `${part('day')} ${part('month')} ${part('year')}`
    : `${part('day')} ${part('month')}, ${part('year')}`;
}

/** '16:00' → '04:00 PM' / '04:00 م'. */
export function formatTicketTime(
  localTime: string,
  language: SupportedLanguage,
): string {
  const [hours, minutes] = localTime.split(':').map(Number);
  return new Intl.DateTimeFormat(TIME_LOCALE[language], {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}

/** 210 → '3hr 30mins' / '3 س 30 د'. */
export function formatTicketDuration(
  totalMinutes: number,
  language: SupportedLanguage,
): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (language === 'ar') {
    if (hours > 0) parts.push(`${hours} س`);
    if (minutes > 0 || hours === 0) parts.push(`${minutes} د`);
  } else {
    if (hours > 0) parts.push(`${hours}hr`);
    if (minutes > 0 || hours === 0)
      parts.push(`${minutes}${minutes === 1 ? 'min' : 'mins'}`);
  }
  return parts.join(' ');
}

/** 15500 → '155.00 EGP' / '155.00 ج.م'. */
export function formatTicketFare(
  piastres: number,
  language: SupportedLanguage,
): string {
  const amount = (piastres / 100).toFixed(2);
  return language === 'ar' ? `${amount} ج.م` : `${amount} EGP`;
}
