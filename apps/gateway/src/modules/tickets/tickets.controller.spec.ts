import { StreamableFile } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ACCESS_LEVEL_KEY, STAFF_ROLE_KEY } from '@app/common';

import { TicketsController } from './tickets.controller.js';
import type { TicketsGrpcClientService } from './tickets.grpc.client.js';

const TICKET = '22222222-2222-4222-8222-222222222222';

function controllerWith(client: Partial<TicketsGrpcClientService>) {
  return new TicketsController(client as TicketsGrpcClientService);
}

function accessOf(method: keyof TicketsController) {
  const handler = TicketsController.prototype[method];
  return {
    level: Reflect.getMetadata(ACCESS_LEVEL_KEY, handler) as string | undefined,
    roles: Reflect.getMetadata(STAFF_ROLE_KEY, handler) as string[] | undefined,
  };
}

describe('TicketsController', () => {
  it('downloads the PDF in the language the request asked for', async () => {
    const pdf = vi.fn().mockResolvedValue({
      content: Buffer.from('%PDF-1.3 ...'),
      fileName: 'ticket-TKT-1.pdf',
    });
    const controller = controllerWith({ pdf });

    const file = await controller.pdf({ ticketId: TICKET }, 'ar-EG,ar;q=0.9');

    expect(pdf).toHaveBeenCalledWith({ ticketId: TICKET, language: 'ar' });
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders()).toMatchObject({
      type: 'application/pdf',
      disposition: 'attachment; filename="ticket-TKT-1.pdf"',
    });
    await controller.pdf({ ticketId: TICKET }, 'en-US');
    expect(pdf).toHaveBeenLastCalledWith({ ticketId: TICKET, language: 'en' });
  });

  it('returns the share link with the public path it opens on', async () => {
    const controller = controllerWith({
      shareLink: vi.fn().mockResolvedValue({
        token: 'a.b.c',
        expiresAt: '2099-01-10T14:00:00.000Z',
      }),
    });

    await expect(controller.shareLink({ ticketId: TICKET })).resolves.toEqual({
      token: 'a.b.c',
      expiresAt: '2099-01-10T14:00:00.000Z',
      path: '/api/v1/shared-tickets/a.b.c',
    });
  });

  it('forwards the list page untouched, defaulting the limit to booking', async () => {
    const listPaid = vi.fn().mockResolvedValue({ tickets: [], nextCursor: '' });
    const controller = controllerWith({ listPaid });

    await controller.paid({});
    await controller.paid({ limit: 5, cursor: 'abc' });

    expect(listPaid.mock.calls).toEqual([
      [{ limit: 0, cursor: '' }],
      [{ limit: 5, cursor: 'abc' }],
    ]);
  });

  it.each(['paid', 'cancelled', 'qr', 'shareLink', 'pdf'] as const)(
    'keeps %s to a signed-in traveller',
    (method) => {
      expect(accessOf(method)).toEqual({
        level: 'traveller',
        roles: undefined,
      });
    },
  );

  it('opens the shared ticket without signing in (BR-39)', () => {
    expect(accessOf('shared').level).toBe('public');
  });

  it.each(['verify', 'verificationKeys'] as const)(
    'keeps %s to conductors (BR-01)',
    (method) => {
      expect(accessOf(method)).toEqual({
        level: undefined,
        roles: ['conductor'],
      });
    },
  );
});
