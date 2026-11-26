import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEVER, of, throwError } from 'rxjs';
import { NotificationRecipientService } from './notification-recipient.service.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'traveller@example.com';
const KEY = 'notification-identity-test-service-key';

function harness(
  profile: { email: string | null; fullName?: string } | null = null,
) {
  const travellers = {
    findByAccountId: vi.fn().mockResolvedValue(profile),
    upsertEmail: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    resolveNotificationRecipient: vi.fn(() => of({ email: EMAIL })),
  };
  const grpc = { getService: vi.fn(() => client) };
  const cls = { get: vi.fn(() => 'correlation-1') };
  const service = new NotificationRecipientService(
    travellers as never,
    grpc as never,
    cls as never,
  );
  return { service, travellers, client, grpc };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('NotificationRecipientService', () => {
  it('uses the local address without an identity dependency', async () => {
    const h = harness({ email: EMAIL });
    await expect(h.service.emailFor(ACCOUNT)).resolves.toBe(EMAIL);
    expect(h.grpc.getService).not.toHaveBeenCalled();
    expect(h.travellers.upsertEmail).not.toHaveBeenCalled();
  });

  it.each([null, { email: null, fullName: 'Existing Traveller' }])(
    'recovers and caches an authoritative email for missing/historical profiles (%j)',
    async (profile) => {
      vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', KEY);
      const h = harness(profile);
      await expect(h.service.emailFor(ACCOUNT)).resolves.toBe(EMAIL);
      expect(h.travellers.upsertEmail).toHaveBeenCalledExactlyOnceWith(
        ACCOUNT,
        EMAIL,
      );
      const [request, metadata, options] = h.client.resolveNotificationRecipient
        .mock.calls[0] as unknown as [
        { accountId: string },
        { get(key: string): unknown[] },
        { deadline: number },
      ];
      expect(request).toEqual({ accountId: ACCOUNT });
      expect(metadata.get('x-notification-identity-key')).toEqual([KEY]);
      expect(metadata.get('x-correlation-id')).toEqual(['correlation-1']);
      expect(options.deadline).toBeGreaterThan(Date.now() - 1_000);
      expect(options.deadline).toBeLessThanOrEqual(Date.now() + 1_000);
      if (profile) expect(profile.fullName).toBe('Existing Traveller');
      h.travellers.findByAccountId.mockResolvedValue({ email: EMAIL });
      await h.service.emailFor(ACCOUNT);
      expect(h.client.resolveNotificationRecipient).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, '', 'short'])(
    'fails closed when the private lookup key is %j',
    async (key) => {
      vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', key);
      const h = harness();
      await expect(h.service.emailFor(ACCOUNT)).rejects.toThrow(
        'not configured',
      );
      expect(h.grpc.getService).not.toHaveBeenCalled();
    },
  );

  it('propagates identity outages without caching or permanently skipping', async () => {
    vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', KEY);
    const h = harness();
    h.client.resolveNotificationRecipient.mockReturnValue(
      throwError(() => new Error('identity unavailable')),
    );
    await expect(h.service.emailFor(ACCOUNT)).rejects.toThrow(
      'identity unavailable',
    );
    expect(h.travellers.upsertEmail).not.toHaveBeenCalled();
    h.client.resolveNotificationRecipient.mockReturnValue(of({ email: EMAIL }));
    await expect(h.service.emailFor(ACCOUNT)).resolves.toBe(EMAIL);
  });

  it.each(['', 'invalid', 'address@example.com\r\nBcc: victim@example.com'])(
    'does not cache an unavailable/invalid recipient (%j)',
    async (email) => {
      vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', KEY);
      const h = harness();
      h.client.resolveNotificationRecipient.mockReturnValue(of({ email }));
      await expect(h.service.emailFor(ACCOUNT)).rejects.toThrow(
        'not available yet',
      );
      expect(h.travellers.upsertEmail).not.toHaveBeenCalled();
    },
  );

  it('bounds an unresponsive directory request', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', KEY);
    const h = harness();
    h.client.resolveNotificationRecipient.mockReturnValue(NEVER);
    const result = expect(h.service.emailFor(ACCOUNT)).rejects.toThrow(
      'Timeout',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(h.travellers.upsertEmail).not.toHaveBeenCalled();
  });
});

describe('NotificationRecipientService.recipientFor (TA-108)', () => {
  it("answers from the account's recorded language, with no identity call", async () => {
    const h = harness({ email: EMAIL });
    (
      h.travellers.findByAccountId as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ email: EMAIL, language: 'en' });

    await expect(h.service.recipientFor(ACCOUNT)).resolves.toEqual({
      email: EMAIL,
      language: 'en',
    });
    expect(h.grpc.getService).not.toHaveBeenCalled();
  });

  it('asks identity once for an account recorded before its language was', async () => {
    vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', KEY);
    const h = harness({ email: EMAIL });
    const recordLanguage = vi.fn().mockResolvedValue(undefined);
    Object.assign(h.travellers, { recordLanguage });
    h.client.resolveNotificationRecipient.mockReturnValue(
      of({ email: EMAIL, language: 'ar' }),
    );

    await expect(h.service.recipientFor(ACCOUNT)).resolves.toEqual({
      email: EMAIL,
      language: 'ar',
    });
    expect(recordLanguage).toHaveBeenCalledExactlyOnceWith(ACCOUNT, 'ar');
  });
});
