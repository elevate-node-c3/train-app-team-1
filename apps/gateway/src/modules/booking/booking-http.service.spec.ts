import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
import { BookingHttpService } from './booking.service.js';

const key = 'gateway-booking-test-credential-long-enough';
const dto = {
  bookingKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  passengerIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
  tripId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  travelClassId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  originStationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  destinationStationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Gateway Booking HTTP boundary', () => {
  it('forwards only approved identifiers and unwraps the existing envelope', async () => {
    vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', key);
    const response = {
      id: dto.bookingKey,
      serverNow: '2026-11-15T12:00:00Z',
      expiresAt: '2026-11-15T12:15:00Z',
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: response }));
    vi.stubGlobal('fetch', fetch);
    const service = new BookingHttpService('http://booking:3000/');
    await expect(
      service.createDraft(
        {
          ...dto,
          userId: 'spoofed',
          passengers: [{ nationalId: '29001018888888' }],
        } as unknown as typeof dto,
        'verified-owner',
      ),
    ).resolves.toEqual(response);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('http://booking:3000/drafts');
    expect(options.headers['x-gateway-booking-key']).toBe(key);
    expect(JSON.parse(options.body)).toEqual({
      userId: 'verified-owner',
      bookingKey: dto.bookingKey,
      passengerIds: dto.passengerIds,
      legs: [
        {
          tripId: dto.tripId,
          travelClassId: dto.travelClassId,
          originStationId: dto.originStationId,
          destinationStationId: dto.destinationStationId,
        },
      ],
    });
    expect(options.body).not.toContain('nationalId');
    expect(options.body).not.toContain('spoofed');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves the machine code and masked passenger detail across both HTTP envelopes', async () => {
    vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', key);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            success: false,
            error: {
              code: ErrorCode.PASSENGER_OVERLAP,
              message: 'do not trust upstream free text',
              details: [
                {
                  field: 'passengerIds',
                  rejectedValue: {
                    passengerRef: dto.passengerIds[0],
                    maskedNationalId: '**********8888',
                  },
                  issue: 'localized upstream text',
                },
              ],
            },
          },
          { status: 409 },
        ),
      ),
    );
    try {
      await new BookingHttpService().createDraft(dto, 'verified-owner');
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: ErrorCode.PASSENGER_OVERLAP,
        details: [
          {
            rejectedValue: {
              passengerRef: dto.passengerIds[0],
              maskedNationalId: '**********8888',
            },
            issueKey: 'ISSUE_PASSENGER_ALREADY_TRAVELLING',
            params: { maskedNationalId: '**********8888' },
          },
        ],
      });
      expect(
        JSON.stringify((error as HttpException).getResponse()),
      ).not.toContain('upstream');
    }
  });

  it('does not forward plaintext IDs disguised as refusal details', async () => {
    vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', key);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            {
              error: {
                code: ErrorCode.PASSENGER_OVERLAP,
                details: [{ rejectedValue: '29001018888888' }],
              },
            },
            { status: 409 },
          ),
        ),
    );
    await expect(
      new BookingHttpService().createDraft(dto, 'verified-owner'),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PASSENGER_OVERLAP },
    });
  });

  it('fails closed before network activity when its service key is missing', async () => {
    vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', '');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      new BookingHttpService().createDraft(dto, 'verified-owner'),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
