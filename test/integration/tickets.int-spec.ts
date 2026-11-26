import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { DataSource } from 'typeorm';
import { CALLER_ACCOUNT_ID_KEY, CALLER_ROLES_KEY } from '@app/common';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { civilDateTimeOf, ErrorCode, type QuotedLeg } from '@app/contracts';

import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { TicketIssuerService } from '../../apps/booking/src/modules/flow/services/ticket-issuer.service.js';
import type { TicketSignerService } from '../../apps/booking/src/modules/tickets/services/ticket-signer.service.js';
import { TicketsService } from '../../apps/booking/src/modules/tickets/services/tickets.service.js';
import { TicketsRepository } from '../../apps/booking/src/modules/tickets/tickets.repository.js';
import {
  bookingDataSource,
  closeBookingDataSource,
  truncateBooking,
} from './support/booking-database.js';
import {
  TEST_TRAVEL_CLASS,
  testQuotedLeg,
  testTicketSigner,
} from './support/ticket-fixture.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let ds: DataSource;
let unitOfWork: TypeOrmUnitOfWork;
let signer: TicketSignerService;
let issuer: TicketIssuerService;
let repository: TicketsRepository;

function callerAs(accountId: string, roles: string[] = []): ClsService {
  const values: Record<string, unknown> = {
    [CALLER_ACCOUNT_ID_KEY]: accountId,
    [CALLER_ROLES_KEY]: roles,
  };
  return { get: (key: string) => values[key] } as unknown as ClsService;
}

function serviceFor(accountId: string, roles: string[] = []): TicketsService {
  return new TicketsService(repository, signer, callerAs(accountId, roles));
}

/** An instant as catalog quotes it: Cairo wall clock with its offset. */
function cairo(instant: Date): string {
  const at = civilDateTimeOf(instant);
  return `${at.localDate}T${at.localTime}:00${at.utcOffset}`;
}

function legAt(
  departs: Date,
  hours = 3,
  options: Parameters<typeof testQuotedLeg>[1] = {},
): QuotedLeg {
  return testQuotedLeg(randomUUID(), {
    departs: cairo(departs),
    arrives: cairo(new Date(departs.getTime() + hours * HOUR)),
    ...options,
  });
}

/** A confirmed booking's tickets, issued exactly as the saga issues them. */
async function issue(props: {
  owner: string;
  passengers: string[];
  legs: QuotedLeg[];
}): Promise<{
  id: string;
  tickets: TicketEntity[];
  draft: BookingDraftEntity;
}> {
  const id = randomUUID();
  await ds.query(`INSERT INTO booking_draft (id, user_id) VALUES ($1, $2)`, [
    id,
    props.owner,
  ]);
  const draft = Object.assign(new BookingDraftEntity(), {
    id,
    userId: props.owner,
    travelClass: TEST_TRAVEL_CLASS,
    quotedLegs: props.legs,
    passengerSnapshot: props.passengers.map((name, index) => ({
      passengerRef: `passenger-${index + 1}`,
      displayName: name,
      maskedNationalId: `**********${String(1000 + index)}`,
      identities: [],
    })),
    settledSeats: props.passengers.flatMap((_name, index) =>
      props.legs.map((leg, legIndex) => ({
        passengerRef: `passenger-${index + 1}`,
        tripId: leg.tripId,
        coachNumber: legIndex + 1,
        seatNumber: String(10 + index),
      })),
    ),
  });
  const tickets = await unitOfWork.withTransaction((ctx) =>
    issuer.issue(ctx, draft),
  );
  return { id, tickets, draft };
}

async function setStatus(
  ticketId: string,
  status: 'cancelled' | 'voided',
  reason: string,
): Promise<void> {
  // BOOK-4 (TA-109) owns cancelling; this stands in for its write.
  await ds.query(
    `UPDATE ticket SET status = $2, status_reason = $3, status_changed_at = now()
      WHERE id = $1`,
    [ticketId, status, reason],
  );
}

beforeEach(async () => {
  ds = await bookingDataSource();
  await truncateBooking(ds);
  unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(ds));
  signer = testTicketSigner();
  issuer = new TicketIssuerService(signer);
  repository = new TicketsRepository(ds.getRepository(TicketEntity));
});

afterAll(async () => {
  await closeBookingDataSource();
});

describe('Ticket issuance: one per passenger per leg (BR-37)', () => {
  it.each([
    [1, 1, 1],
    [3, 1, 3],
    [3, 2, 6],
    [4, 2, 8],
  ])(
    '%i passenger(s) on %i leg(s) get %i ticket(s), all sharing one booking code',
    async (passengers, legs, expected) => {
      const tomorrow = new Date(Date.now() + DAY);
      const quoted = Array.from({ length: legs }, (_, index) =>
        legAt(new Date(tomorrow.getTime() + index * 2 * DAY), 3, {
          farePiastres: 15_500 + index * 1_000,
        }),
      );
      const names = ['Omar Khaled', 'Mona Ahmed', 'Sara Ali', 'Youssef Adel'];

      const { id, tickets, draft } = await issue({
        owner: randomUUID(),
        passengers: names.slice(0, passengers),
        legs: quoted,
      });

      expect(tickets).toHaveLength(expected);
      const codes = new Set(
        tickets.map((ticket) => ticket.snapshot?.bookingCode),
      );
      expect(codes.size).toBe(1);
      expect([...codes][0]).toMatch(/^[A-Z2-9]{6}$/);
      expect(new Set(tickets.map((ticket) => ticket.bookingReference))).toEqual(
        new Set([id]),
      );
      for (const seat of draft.settledSeats ?? []) {
        const matching = tickets.filter(
          (ticket) =>
            ticket.passengerRef === seat.passengerRef &&
            ticket.tripId === seat.tripId,
        );
        expect(matching).toHaveLength(1);
        const [ticket] = matching;
        const leg = quoted.find(
          (candidate) => candidate.tripId === seat.tripId,
        )!;
        expect(ticket.coachNumber).toBe(seat.coachNumber);
        expect(ticket.seatNumber).toBe(seat.seatNumber);
        expect(ticket.snapshot?.farePiastres).toBe(leg.fare.amountMinor);
        expect(ticket.snapshot?.boarding).toEqual(leg.departure);
        expect(ticket.snapshot?.alighting).toEqual(leg.arrival);
        expect(ticket.departsAt).toEqual(new Date(leg.departure.at.iso));
        expect(ticket.qrPayload).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      }
    },
  );

  it('issues nothing twice when the confirm step is replayed', async () => {
    const first = await issue({
      owner: randomUUID(),
      passengers: ['Omar Khaled', 'Mona Ahmed'],
      legs: [legAt(new Date(Date.now() + DAY))],
    });

    const replay = await unitOfWork.withTransaction((ctx) =>
      issuer.issue(ctx, first.draft),
    );

    expect(replay.map((ticket) => [ticket.id, ticket.qrPayload])).toEqual(
      first.tickets.map((ticket) => [ticket.id, ticket.qrPayload]),
    );
    expect(replay[0].snapshot?.bookingCode).toBe(
      first.tickets[0].snapshot?.bookingCode,
    );
  });

  it('gives every booking its own code', async () => {
    const leg = legAt(new Date(Date.now() + DAY));
    const one = await issue({
      owner: randomUUID(),
      passengers: ['A'],
      legs: [leg],
    });
    const two = await issue({
      owner: randomUUID(),
      passengers: ['B'],
      legs: [legAt(new Date(Date.now() + DAY))],
    });

    expect(one.tickets[0].snapshot?.bookingCode).not.toBe(
      two.tickets[0].snapshot?.bookingCode,
    );
  });
});

describe('The issued snapshot is the ticket', () => {
  it('survives a renamed passenger and a republished timetable unchanged', async () => {
    const owner = randomUUID();
    const { id, tickets } = await issue({
      owner,
      passengers: ['Omar Khaled Hassan'],
      legs: [legAt(new Date(Date.now() + DAY))],
    });
    const before = (await repository.findById(tickets[0].id))!;

    // Everything a live source could change, changed at once.
    await ds.query(
      `UPDATE booking_draft
          SET passenger_snapshot = $2::jsonb, quoted_legs = $3::jsonb,
              travel_class = $4::jsonb
        WHERE id = $1`,
      [
        id,
        JSON.stringify([
          {
            passengerRef: 'passenger-1',
            displayName: 'Renamed Passenger',
            maskedNationalId: '**********9999',
            identities: [],
          },
        ]),
        JSON.stringify([
          legAt(new Date(Date.now() + 3 * DAY), 5, { trainNumber: 999 }),
        ]),
        JSON.stringify({ id: 'x', name: { en: 'Other', ar: 'أخرى' } }),
      ],
    );

    const after = (await repository.findById(tickets[0].id))!;
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.snapshot.passengerName).toBe('Omar Khaled Hassan');
    expect(after.qrPayload).toBe(before.qrPayload);
    const verified = await signer.verifyQr(after.qrPayload);
    expect(verified).toMatchObject({
      status: 'valid',
      claims: { passengerName: 'Omar Khaled Hassan', trainNumber: 916 },
    });

    const card = (await serviceFor(owner).listPaid({ limit: 0, cursor: '' }))
      .tickets[0];
    expect(card.passengerName).toBe('Omar Khaled Hassan');
    expect(card.travelClass.name.en).toBe('Second Class AC');
  });

  it("dates an overnight boarding by the passenger's own station", async () => {
    const { tickets } = await issue({
      owner: randomUUID(),
      passengers: ['Mona Ahmed'],
      legs: [
        testQuotedLeg(randomUUID(), {
          departs: '2099-12-02T04:10:00+02:00',
          arrives: '2099-12-02T09:40:00+02:00',
        }),
      ],
    });

    const ticket = (await repository.findById(tickets[0].id))!;
    expect(ticket.snapshot.boarding.at.localDate).toBe('2099-12-02');
    expect(ticket.departsAt).toEqual(new Date('2099-12-02T02:10:00.000Z'));
    const verified = await signer.verifyQr(ticket.qrPayload);
    expect(verified).toMatchObject({ claims: { boardingDate: '2099-12-02' } });
  });
});

describe('Paid and Canceled lists (BR-40)', () => {
  async function aTravellersTickets(owner: string) {
    const now = Date.now();
    const at = async (offset: number, passengers = ['P']) =>
      (
        await issue({
          owner,
          passengers,
          legs: [legAt(new Date(now + offset), 3)],
        })
      ).tickets;

    const pastOld = await at(-3 * DAY);
    const pastRecent = await at(-2 * DAY);
    const onBoard = await at(-1 * HOUR);
    const tiedPair = await at(1 * DAY, ['A', 'B']);
    const later = await at(5 * DAY);
    const cancelled = await at(2 * DAY);
    const voided = await at(3 * DAY);
    await setStatus(cancelled[0].id, 'cancelled', 'TRAVELLER_CANCELLED');
    await setStatus(voided[0].id, 'voided', 'TRIP_CANCELLED');
    // Another traveller's ticket, on the very same day.
    await issue({
      owner: randomUUID(),
      passengers: ['Stranger'],
      legs: [legAt(new Date(now + DAY))],
    });

    return {
      expectedPaid: [
        onBoard[0].id,
        ...tiedPair.map((ticket) => ticket.id).sort(),
        later[0].id,
        pastRecent[0].id,
        pastOld[0].id,
      ],
      cancelled: cancelled[0].id,
      voided: voided[0].id,
    };
  }

  it('pages upcoming first, nearest first, then past, newest first, with nothing lost or repeated', async () => {
    const owner = randomUUID();
    const { expectedPaid } = await aTravellersTickets(owner);
    const service = serviceFor(owner);

    const seen: string[] = [];
    let cursor = '';
    let pages = 0;
    do {
      const page = await service.listPaid({ limit: 2, cursor });
      seen.push(...page.tickets.map((card) => card.ticketId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(expectedPaid);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(3);
  });

  it('tells each card what it allows, decided by booking', async () => {
    const owner = randomUUID();
    const { expectedPaid } = await aTravellersTickets(owner);

    const { tickets } = await serviceFor(owner).listPaid({
      limit: 50,
      cursor: '',
    });
    const actions = Object.fromEntries(
      tickets.map((card) => [card.ticketId, card.allowedActions]),
    );

    // On board: still shown to the conductor.
    expect(actions[expectedPaid[0]]).toMatchObject({ qr: true, share: true });
    // Past: a receipt only.
    expect(actions[expectedPaid.at(-1)!]).toEqual({
      share: false,
      qr: false,
      download: true,
      cancel: false,
    });
  });

  it('lists cancelled and voided tickets, with their reasons, and nothing else', async () => {
    const owner = randomUUID();
    const { cancelled, voided } = await aTravellersTickets(owner);

    const { tickets } = await serviceFor(owner).listCancelled({
      limit: 0,
      cursor: '',
    });

    expect(
      tickets.map((card) => [card.ticketId, card.status, card.statusReason]),
    ).toEqual([
      [cancelled, 'cancelled', 'TRAVELLER_CANCELLED'],
      [voided, 'voided', 'TRIP_CANCELLED'],
    ]);
    expect(tickets.every((card) => !card.allowedActions.download)).toBe(true);
  });

  it('reads each page in one statement, however many tickets it holds', async () => {
    const owner = randomUUID();
    await issue({
      owner,
      passengers: ['A', 'B', 'C', 'D'],
      legs: [
        legAt(new Date(Date.now() + DAY)),
        legAt(new Date(Date.now() + 2 * DAY)),
      ],
    });
    const tickets = ds.getRepository(TicketEntity);
    const query = vi.spyOn(tickets, 'query');
    const counted = new TicketsService(
      new TicketsRepository(tickets),
      signer,
      callerAs(owner),
    );

    const page = await counted.listPaid({ limit: 50, cursor: '' });

    expect(page.tickets).toHaveLength(8);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('Current state, read every time', () => {
  it('fails the online check and the share link the moment a ticket is cancelled', async () => {
    const owner = randomUUID();
    const { tickets } = await issue({
      owner,
      passengers: ['Omar Khaled Hassan'],
      legs: [legAt(new Date(Date.now() + DAY))],
    });
    const [ticket] = tickets;
    const conductor = serviceFor(randomUUID(), ['conductor']);
    const traveller = serviceFor(owner);
    const link = await traveller.shareLink({ ticketId: ticket.id });

    await expect(
      conductor.verify({ qr: ticket.qrPayload! }),
    ).resolves.toMatchObject({ valid: true, result: 'VALID' });
    await expect(
      traveller.shared({ token: link.token }),
    ).resolves.toMatchObject({ ticketNumber: ticket.ticketNumber });

    await setStatus(ticket.id, 'cancelled', 'TRAVELLER_CANCELLED');

    await expect(
      conductor.verify({ qr: ticket.qrPayload! }),
    ).resolves.toMatchObject({
      valid: false,
      result: 'CANCELLED',
      reason: 'TRAVELLER_CANCELLED',
    });
    await expect(traveller.shared({ token: link.token })).rejects.toMatchObject(
      {
        code: ErrorCode.RESOURCE_NOT_FOUND,
      },
    );
    await expect(
      traveller.pdf({ ticketId: ticket.id, language: 'en' }),
    ).rejects.toMatchObject({ code: ErrorCode.TICKET_NOT_ACTIVE });
  });

  it("answers another traveller's ticket as not found", async () => {
    const { tickets } = await issue({
      owner: randomUUID(),
      passengers: ['Omar Khaled Hassan'],
      legs: [legAt(new Date(Date.now() + DAY))],
    });
    const stranger = serviceFor(randomUUID());

    for (const call of [
      () => stranger.qr({ ticketId: tickets[0].id }),
      () => stranger.shareLink({ ticketId: tickets[0].id }),
      () => stranger.pdf({ ticketId: tickets[0].id, language: 'ar' }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_NOT_FOUND,
      });
    }
    const { tickets: listed } = await stranger.listPaid({
      limit: 0,
      cursor: '',
    });
    expect(listed).toEqual([]);
  });
});
