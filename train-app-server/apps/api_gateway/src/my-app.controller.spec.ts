import { Test, TestingModule } from '@nestjs/testing';
import { MyAppController } from './api_gateway.controller.js';
import { MyAppService } from './my-app.service.js';

describe('MyAppController', () => {
  let myAppController: MyAppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [MyAppController],
      providers: [MyAppService],
    }).compile();

    myAppController = app.get<MyAppController>(MyAppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(myAppController.getHello()).toBe('Hello World!');
    });
  });
});
