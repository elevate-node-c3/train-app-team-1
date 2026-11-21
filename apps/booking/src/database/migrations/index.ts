import { CreateBookingDraftTables1793500000000 } from './1793500000000-create-booking-draft-tables.js';
import { BookingHoldIntent1794764000000 } from './1794764000000-booking-hold-intent.js';
import { BookingCheckoutFlow1795000000002 } from './1795000000002-booking-checkout-flow.js';
import { BookingConfirmationSaga1797200000001 } from './1797200000001-booking-confirmation-saga.js';
import { PaymentEventIdIsText1797200000002 } from './1797200000002-payment-event-id-is-text.js';

export const migrations = [
  CreateBookingDraftTables1793500000000,
  BookingHoldIntent1794764000000,
  BookingCheckoutFlow1795000000002,
  BookingConfirmationSaga1797200000001,
  PaymentEventIdIsText1797200000002,
];
