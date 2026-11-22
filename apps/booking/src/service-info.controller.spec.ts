import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { ResponseInterceptor } from '@app/common/envelope/response.interceptor.js';
import { ServiceInfoController } from './service-info.controller.js';
import { BookingFlowRepository } from './modules/flow/booking-flow.repository.js';

describe('Booking service charged-without-outcome HTTP gauge', () => {
  it('returns the live count under the real response envelope data field', async () => {
    const findChargedWithoutOutcome = vi
      .fn()
      .mockResolvedValue([{ id: 'booking', sagaStep: 'refunding' }]);
    const module = await Test.createTestingModule({
      controllers: [ServiceInfoController],
      providers: [
        {
          provide: BookingFlowRepository,
          useValue: { findChargedWithoutOutcome },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalInterceptors(
      new ResponseInterceptor({ get: () => 'test' } as unknown as ClsService),
    );
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/booking')
        .expect(200);
      expect(response.body.data.chargedWithoutOutcome).toBe(1);
      expect(response.body.chargedWithoutOutcome).toBeUndefined();
      expect(findChargedWithoutOutcome).toHaveBeenCalledWith(60);
    } finally {
      await app.close();
    }
  });
});
