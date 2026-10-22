import { Test, TestingModule } from '@nestjs/testing';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

describe('BookingsController', () => {
  let bookingsController: BookingsController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [BookingsController],
      providers: [BookingsService],
    }).compile();

    bookingsController = app.get<BookingsController>(BookingsController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(bookingsController.getHello()).toBe('Hello World!');
    });
  });
});
