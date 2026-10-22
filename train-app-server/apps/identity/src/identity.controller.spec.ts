import { Test, TestingModule } from '@nestjs/testing';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';

describe('IdentityController', () => {
  let identityController: IdentityController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [IdentityService],
    }).compile();

    identityController = app.get<IdentityController>(IdentityController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(identityController.getHello()).toBe('Hello World!');
    });
  });
});
