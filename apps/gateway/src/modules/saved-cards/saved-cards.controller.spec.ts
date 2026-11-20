import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCaller } from '@app/common';
import { SavedCardsController } from './saved-cards.controller.js';
import type { SavedCardsService } from './saved-cards.service.js';

describe('SavedCardsController', () => {
  let controller: SavedCardsController;
  let mockService: {
    createSetupIntent: ReturnType<typeof vi.fn>;
    confirmSetup: ReturnType<typeof vi.fn>;
    listSavedCards: ReturnType<typeof vi.fn>;
    deleteSavedCard: ReturnType<typeof vi.fn>;
  };

  const caller: AuthenticatedCaller = {
    accountId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1',
    jti: 'jti-1',
    level: 'traveller',
    roles: [],
    bookable: true,
    expiresAt: Date.now() + 60000,
  };

  beforeEach(() => {
    mockService = {
      createSetupIntent: vi.fn().mockResolvedValue({
        setupIntentId: 'seti_1',
        clientSecret: 'secret_1',
        publishableKey: 'pk_1',
      }),
      confirmSetup: vi.fn().mockResolvedValue({
        card: { id: 'card-1', brand: 'visa', last4: '4242' },
      }),
      listSavedCards: vi.fn().mockResolvedValue({ cards: [] }),
      deleteSavedCard: vi.fn().mockResolvedValue({ success: true }),
    };

    controller = new SavedCardsController(
      mockService as unknown as SavedCardsService,
    );
  });

  it('createSetupIntent uses authenticated caller accountId', async () => {
    const res = await controller.createSetupIntent(caller);
    expect(mockService.createSetupIntent).toHaveBeenCalledWith(caller.accountId);
    expect(res.setupIntentId).toBe('seti_1');
  });

  it('confirmSetup passes caller accountId and setupIntentId', async () => {
    await controller.confirmSetup(caller, { setupIntentId: 'seti_1' });
    expect(mockService.confirmSetup).toHaveBeenCalledWith(
      caller.accountId,
      'seti_1',
    );
  });

  it('listSavedCards uses caller accountId', async () => {
    await controller.listSavedCards(caller);
    expect(mockService.listSavedCards).toHaveBeenCalledWith(caller.accountId);
  });

  it('deleteSavedCard uses caller accountId and cardId param', async () => {
    await controller.deleteSavedCard(caller, { cardId: '22222222-2222-4222-8222-222222222222' });
    expect(mockService.deleteSavedCard).toHaveBeenCalledWith(
      caller.accountId,
      '22222222-2222-4222-8222-222222222222',
    );
  });
});
