import { afterEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { HttpExceptionFilter } from '@app/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { BookingController } from './booking.controller.js';
import { BookingService } from './booking.service.js';
import { BookingRequestGuard } from './booking-request.guard.js';

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('BR-10 actual Gateway booking entry', () => {
  it.each([false, true])(
    'admits only a bookable profile (bookable=%s)',
    async (bookable) => {
      const values = new Map<string, unknown>();
      const cls = {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      };
      const booking = {
        createBooking: vi
          .fn()
          .mockResolvedValue({
            id: 'draft',
            serverNow: '2026-11-15T12:00:00Z',
          }),
      };
      const module = await Test.createTestingModule({
        controllers: [BookingController],
        providers: [
          BookingRequestGuard,
          { provide: ClsService, useValue: cls },
          { provide: BookingService, useValue: booking },
          {
            provide: APP_GUARD,
            useFactory: () =>
              new JwtAuthGuard(
                new Reflector(),
                cls as never,
                {
                  verify: vi
                    .fn()
                    .mockResolvedValue({
                      sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      lvl: bookable ? 'bookable' : 'traveller',
                      bkbl: bookable,
                      roles: [],
                      sid: 'session',
                      jti: 'token',
                      exp: 1_900_000_000,
                    }),
                } as never,
                { isRevoked: vi.fn().mockResolvedValue(false) } as never,
              ),
          },
        ],
      }).compile();
      app = module.createNestApplication();
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
      const response = await request(app.getHttpServer())
        .post('/bookings')
        .set('Authorization', 'Bearer verified')
        .send({
          bookingKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          passengerIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
          legs: [
            {
              tripId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              travelClassId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              originStationId: '11111111-1111-4111-8111-111111111111',
              destinationStationId: '22222222-2222-4222-8222-222222222222',
            },
          ],
        });
      if (bookable) {
        expect(response.status).toBe(201);
        expect(booking.createBooking).toHaveBeenCalledOnce();
      } else {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PROFILE_INCOMPLETE');
        expect(booking.createBooking).not.toHaveBeenCalled();
      }
    },
  );
});
