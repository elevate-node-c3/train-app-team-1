import { generateKeyPairSync } from 'node:crypto';
import type { QuotedLeg, TravelClass } from '@app/contracts';

import { TicketSignerService } from '../../../apps/booking/src/modules/tickets/services/ticket-signer.service.js';

/**
 * What every real draft carries by the time it is confirmed: the class and
 * the legs catalog quoted when the price was locked (BR-30), and identity's
 * masked National ID. The ticket snapshot is copied from exactly these.
 */
export const TEST_TRAVEL_CLASS: TravelClass = {
  id: '00000000-0000-4000-8000-00000000c1a5',
  name: { en: 'Second Class AC', ar: 'الدرجة الثانية مكيفة' },
};

export const TEST_MASKED_NATIONAL_ID = '**********1234';

export function testQuotedLeg(
  tripId: string,
  options: {
    trainNumber?: number;
    departs?: string;
    arrives?: string;
    farePiastres?: number;
  } = {},
): QuotedLeg {
  const departs = options.departs ?? '2099-01-10T12:30:00+02:00';
  const arrives = options.arrives ?? '2099-01-10T16:00:00+02:00';
  return {
    tripId,
    trainNumber: options.trainNumber ?? 916,
    trainType: { en: 'Express', ar: 'إكسبريس' },
    departure: {
      stationId: '00000000-0000-4000-8000-0000000005a1',
      name: { en: 'El Raml Station', ar: 'محطة الرمل' },
      at: civil(departs),
    },
    arrival: {
      stationId: '00000000-0000-4000-8000-0000000005a2',
      name: { en: 'Ramsis Station', ar: 'محطة رمسيس' },
      at: civil(arrives),
    },
    fare: { amountMinor: options.farePiastres ?? 6500, currency: 'EGP' },
  };
}

/** A signer with a fresh Ed25519 key, so no test depends on a key file. */
export function testTicketSigner(keyId = 'ticket-test-1'): TicketSignerService {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = new TicketSignerService();
  signer.load({
    keyId,
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    retiredPublicKeys: [],
  });
  return signer;
}

/** '2099-01-10T12:30:00+02:00' as the wire's Cairo civil time. */
function civil(iso: string) {
  return {
    localDate: iso.slice(0, 10),
    localTime: iso.slice(11, 16),
    utcOffset: iso.slice(19),
    iso,
    timeZone: 'Africa/Cairo',
  };
}
