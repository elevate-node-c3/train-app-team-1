import { describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import { CALLER_ACCOUNT_ID_KEY, CALLER_ROLES_KEY } from '@app/common';
import { ErrorCode, type TicketQrClaims } from '@app/contracts';

import { issuedTicket, signerWithNewKey } from '../testing/ticket-fixtures.js';
import type { IssuedTicket } from '../ticket-view.js';
import type { TicketsRepository } from '../tickets.repository.js';
import { TicketsService } from './tickets.service.js';

const OWNER = 'owner-1';
const SOMEONE_ELSE = 'owner-2';

function callerAs(accountId: string | undefined, roles: string[] = []) {
  const values: Record<string, unknown> = {
    [CALLER_ACCOUNT_ID_KEY]: accountId,
    [CALLER_ROLES_KEY]: roles,
  };
  return { get: (key: string) => values[key] } as unknown as ClsService;
}

function claimsOf(ticket: IssuedTicket): TicketQrClaims {
  return {
    ticketNumber: ticket.ticketNumber,
    trainNumber: ticket.snapshot.trainNumber,
    boardingDate: ticket.snapshot.boarding.at.localDate,
    boardingStation: ticket.snapshot.boarding.name,
    alightingStation: ticket.snapshot.alighting.name,
    coachNumber: ticket.coachNumber,
    seatNumber: ticket.seatNumber,
    passengerName: ticket.snapshot.passengerName,
    nationalIdLast4: ticket.snapshot.nationalIdLast4,
  };
}

/** A repository holding one ticket, read afresh on every call. */
async function harness(
  caller = callerAs(OWNER),
  overrides: Partial<IssuedTicket> = {},
) {
  const { signer } = signerWithNewKey();
  const ticket = issuedTicket(overrides);
  ticket.qrPayload = await signer.signQr(claimsOf(ticket));
  const repository = {
    findById: vi.fn(async (id: string) => (id === ticket.id ? ticket : null)),
    findByTicketNumber: vi.fn(async (number: string) =>
      number === ticket.ticketNumber ? ticket : null,
    ),
    page: vi.fn(),
  };
  const service = new TicketsService(
    repository as unknown as TicketsRepository,
    signer,
    caller,
  );
  return { service, repository, signer, ticket };
}

const refusal = (code: ErrorCode) => expect.objectContaining({ code });

describe('TicketsService: ownership (BR-09)', () => {
  it.each([
    ['qr', (s: TicketsService, id: string) => s.qr({ ticketId: id })],
    ['share', (s: TicketsService, id: string) => s.shareLink({ ticketId: id })],
    [
      'pdf',
      (s: TicketsService, id: string) =>
        s.pdf({ ticketId: id, language: 'en' }),
    ],
  ])(
    "answers another traveller's %s exactly like a missing ticket",
    async (_name, call) => {
      const { service, ticket } = await harness(callerAs(SOMEONE_ELSE));

      await expect(call(service, ticket.id)).rejects.toEqual(
        refusal(ErrorCode.RESOURCE_NOT_FOUND),
      );
      await expect(
        call(service, '99999999-9999-4999-8999-999999999999'),
      ).rejects.toEqual(refusal(ErrorCode.RESOURCE_NOT_FOUND));
    },
  );

  it('lists only the caller’s own tickets', async () => {
    const { service, repository } = await harness();
    repository.page.mockResolvedValue([]);

    await service.listPaid({ limit: 0, cursor: '' });

    expect(repository.page).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, statuses: ['active'] }),
    );
  });

  it('refuses an unsigned caller', async () => {
    const { service } = await harness(callerAs(undefined));

    await expect(service.listPaid({ limit: 0, cursor: '' })).rejects.toEqual(
      refusal(ErrorCode.UNAUTHORIZED),
    );
  });
});

describe('TicketsService: what a ticket allows (BR-39)', () => {
  it('returns the signed QR, its key and its image', async () => {
    const { service, signer, ticket } = await harness();

    const qr = await service.qr({ ticketId: ticket.id });

    expect(qr.payload).toBe(ticket.qrPayload);
    expect(qr.keyId).toBe(signer.keyId);
    expect(qr.image).toMatch(/^data:image\/png;base64,/);
  });

  it.each(['cancelled', 'voided'] as const)(
    'refuses to share, download or show a %s ticket even when asked directly',
    async (status) => {
      const { service, ticket } = await harness(callerAs(OWNER), { status });

      for (const call of [
        () => service.shareLink({ ticketId: ticket.id }),
        () => service.pdf({ ticketId: ticket.id, language: 'en' }),
        () => service.qr({ ticketId: ticket.id }),
      ]) {
        await expect(call()).rejects.toEqual(
          refusal(ErrorCode.TICKET_NOT_ACTIVE),
        );
      }
    },
  );

  it('renders the PDF in the request language, not the account language', async () => {
    const { service, ticket } = await harness();

    const pdf = await service.pdf({ ticketId: ticket.id, language: 'ar' });

    expect(pdf.fileName).toBe('ticket-TKT-1.pdf');
    expect(pdf.content.toString('latin1')).toContain('/Lang (ar)');
  });
});

describe('TicketsService: share links (BR-39)', () => {
  it('opens one ticket read-only, expiring at the passenger arrival', async () => {
    const { service, ticket } = await harness();

    const link = await service.shareLink({ ticketId: ticket.id });
    const shared = await service.shared({ token: link.token });

    expect(link.expiresAt).toBe(ticket.arrivesAt.toISOString());
    expect(shared).toMatchObject({
      ticketNumber: 'TKT-1',
      passengerName: 'Omar Khaled Hassan',
      coachNumber: 3,
      seatNumber: '12',
    });
    expect(JSON.stringify(shared)).not.toContain('1234');
  });

  it('opens without any signed-in caller', async () => {
    const owner = await harness();
    const link = await owner.service.shareLink({ ticketId: owner.ticket.id });
    const anonymous = new TicketsService(
      owner.repository as unknown as TicketsRepository,
      owner.signer,
      callerAs(undefined),
    );

    await expect(
      anonymous.shared({ token: link.token }),
    ).resolves.toMatchObject({ ticketNumber: 'TKT-1' });
  });

  it('stops working the moment the ticket is cancelled', async () => {
    const { service, ticket } = await harness();
    const link = await service.shareLink({ ticketId: ticket.id });

    ticket.status = 'cancelled';

    await expect(service.shared({ token: link.token })).rejects.toEqual(
      refusal(ErrorCode.RESOURCE_NOT_FOUND),
    );
  });

  it('answers a modified link with not-found', async () => {
    const { service, ticket } = await harness();
    const { token } = await service.shareLink({ ticketId: ticket.id });
    const [header, payload, signature] = token.split('.');
    const swap = (char: string) => (char === 'A' ? 'B' : 'A');

    for (const altered of [
      // A character carrying signature bits.
      `${header}.${payload}.${swap(signature[0])}${signature.slice(1)}`,
      // The last character, whose spare bits a lenient decoder would ignore.
      `${header}.${payload}.${signature.slice(0, -1)}${signature.at(-1) === 'B' ? 'C' : 'B'}`,
      `${header}.${Buffer.from('{"sub":"x","exp":4102444800}').toString('base64url')}.${signature}`,
      'garbage',
    ]) {
      await expect(service.shared({ token: altered })).rejects.toEqual(
        refusal(ErrorCode.RESOURCE_NOT_FOUND),
      );
    }
  });

  it('answers an expired link with not-found', async () => {
    const { service, signer, ticket } = await harness();
    const expired = await signer.signShareToken(
      ticket.id,
      new Date(Date.now() - 1_000),
    );

    await expect(service.shared({ token: expired })).rejects.toEqual(
      refusal(ErrorCode.RESOURCE_NOT_FOUND),
    );
  });
});

describe('TicketsService: the conductor online check', () => {
  const conductor = () => callerAs('conductor-1', ['conductor']);

  it('accepts a valid active ticket', async () => {
    const { service, ticket } = await harness(conductor());

    await expect(
      service.verify({ qr: ticket.qrPayload }),
    ).resolves.toMatchObject({
      valid: true,
      result: 'VALID',
      ticket: { ticketNumber: 'TKT-1' },
    });
  });

  it('rejects a ticket cancelled a moment ago, reading the database each time', async () => {
    const { service, repository, ticket } = await harness(conductor());
    await service.verify({ qr: ticket.qrPayload });

    ticket.status = 'cancelled';
    ticket.statusReason = 'TRAVELLER_CANCELLED';

    await expect(service.verify({ qr: ticket.qrPayload })).resolves.toEqual(
      expect.objectContaining({
        valid: false,
        result: 'CANCELLED',
        reason: 'TRAVELLER_CANCELLED',
      }),
    );
    expect(repository.findByTicketNumber).toHaveBeenCalledTimes(2);
  });

  it('rejects a voided ticket with its reason', async () => {
    const { service, ticket } = await harness(conductor(), {
      status: 'voided',
      statusReason: 'TRIP_CANCELLED',
    });

    await expect(service.verify({ qr: ticket.qrPayload })).resolves.toEqual(
      expect.objectContaining({
        valid: false,
        result: 'VOIDED',
        reason: 'TRIP_CANCELLED',
      }),
    );
  });

  it('rejects a tampered, malformed or unknown QR', async () => {
    const { service, signer, ticket } = await harness(conductor());
    const [header, , signature] = ticket.qrPayload.split('.');
    const tampered = `${header}.${Buffer.from(
      JSON.stringify({ ...claimsOf(ticket), seatNumber: '13' }),
    ).toString('base64url')}.${signature}`;
    const unknown = await signer.signQr({
      ...claimsOf(ticket),
      ticketNumber: 'TKT-999',
    });

    expect((await service.verify({ qr: tampered })).result).toBe(
      'INVALID_SIGNATURE',
    );
    expect((await service.verify({ qr: 'not a qr' })).result).toBe('MALFORMED');
    expect((await service.verify({ qr: unknown })).result).toBe(
      'UNKNOWN_TICKET',
    );
  });

  it('is closed to a traveller, even with a genuine QR', async () => {
    const { service, ticket } = await harness(callerAs(OWNER));

    await expect(service.verify({ qr: ticket.qrPayload })).rejects.toEqual(
      refusal(ErrorCode.FORBIDDEN),
    );
    await expect(service.verificationKeys()).rejects.toEqual(
      refusal(ErrorCode.FORBIDDEN),
    );
  });

  it('gives a conductor the public keys and nothing private', async () => {
    const { service, signer } = await harness(conductor());

    const { keys } = await service.verificationKeys();

    expect(keys).toEqual([
      expect.objectContaining({
        kid: signer.keyId,
        kty: 'OKP',
        crv: 'Ed25519',
      }),
    ]);
    expect(keys[0]).not.toHaveProperty('d');
  });
});

describe('TicketsService: pages', () => {
  it('hands back a cursor only when another page exists, and keeps its moment', async () => {
    const { service, repository } = await harness();
    const rows = [1, 2, 3].map((n) => ({
      ticket: issuedTicket({
        id: `00000000-0000-4000-8000-00000000000${n}`,
      }),
      bucket: 0,
      sortKey: `${4_071_000_000 + n}.000000`,
    }));
    repository.page.mockResolvedValueOnce(rows);

    const first = await service.listPaid({ limit: 2, cursor: '' });

    expect(first.tickets.map((card) => card.ticketId)).toEqual([
      rows[0].ticket.id,
      rows[1].ticket.id,
    ]);
    expect(first.nextCursor).not.toBe('');

    repository.page.mockResolvedValueOnce([rows[2]]);
    const second = await service.listPaid({
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(second.nextCursor).toBe('');
    const [firstCall, secondCall] = repository.page.mock.calls.map(
      ([input]) => input as { asOf: Date; after: unknown; limit: number },
    );
    expect(secondCall.asOf).toEqual(firstCall.asOf);
    expect(secondCall.after).toMatchObject({
      bucket: 0,
      sortKey: rows[1].sortKey,
      ticketId: rows[1].ticket.id,
    });
  });

  it('lists cancelled and voided tickets together', async () => {
    const { service, repository } = await harness();
    repository.page.mockResolvedValue([]);

    await service.listCancelled({ limit: 0, cursor: '' });

    expect(repository.page).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['cancelled', 'voided'],
        limit: 20,
      }),
    );
  });
});
