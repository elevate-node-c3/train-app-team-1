import { describe, expect, it, vi } from 'vitest';
import type {
  CompleteProfileResponseDto,
  ProfileOptionsResponseDto,
  ProfileResponseDto,
} from '@app/contracts';
import { ACCESS_LEVEL_KEY, RATE_LIMIT_KEY, type RateLimitOptions } from '@app/common';
import { ProfileController } from './profile.controller.js';
import type { IdentityService } from '../identity.service.js';

const COMPLETE_RESPONSE: CompleteProfileResponseDto = {
  tokens: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    accessExpiresIn: 900,
    refreshExpiresIn: 2_592_000,
  },
  profile: {
    accountId: 'account-1',
    fullName: 'Ahmed Hussein',
    phoneNumber: '01001234567',
    nationalId: '28505150101235',
    profileType: 'Regular',
    nationality: 'Egyptian',
    bookable: true,
  },
};

const PROFILE_RESPONSE: ProfileResponseDto = {
  accountId: 'account-1',
  fullName: 'Ahmed Hussein',
  phoneNumber: '01001234567',
  nationalId: '28505150101235',
  profileType: 'Regular',
  nationality: 'Egyptian',
  bookable: true,
};

const OPTIONS_RESPONSE: ProfileOptionsResponseDto = {
  profileTypes: [{ code: 'Regular', nameAr: 'عادي', nameEn: 'Regular' }],
  nationalities: [{ code: 'Egyptian', nameAr: 'مصري', nameEn: 'Egyptian' }],
};

function harness(): {
  controller: ProfileController;
  identity: { [K in keyof IdentityService]: ReturnType<typeof vi.fn> };
} {
  const identity = {
    completeProfile: vi.fn(async () => COMPLETE_RESPONSE),
    getProfile: vi.fn(async () => PROFILE_RESPONSE),
    getProfileOptions: vi.fn(async () => OPTIONS_RESPONSE),
  };
  return {
    controller: new ProfileController(identity as unknown as IdentityService),
    identity: identity as any,
  };
}

describe('ProfileController', () => {
  it('forwards completeProfile to identity service', async () => {
    const { controller, identity } = harness();
    const body = {
      fullName: 'Ahmed Hussein',
      phoneNumber: '01001234567',
      nationalId: '28505150101235',
      profileType: 'Regular',
      nationality: 'Egyptian',
    };

    await expect(controller.complete(body)).resolves.toEqual(COMPLETE_RESPONSE);
    expect(identity.completeProfile).toHaveBeenCalledWith(body);
  });

  it('forwards getProfile to identity service', async () => {
    const { controller, identity } = harness();
    await expect(controller.getProfile()).resolves.toEqual(PROFILE_RESPONSE);
    expect(identity.getProfile).toHaveBeenCalled();
  });

  it('forwards getProfileOptions to identity service', async () => {
    const { controller, identity } = harness();
    await expect(controller.getOptions()).resolves.toEqual(OPTIONS_RESPONSE);
    expect(identity.getProfileOptions).toHaveBeenCalled();
  });

  it('declares access levels: complete and get require traveller, options is public', () => {
    expect(
      Reflect.getMetadata(
        ACCESS_LEVEL_KEY,
        ProfileController.prototype.complete,
      ),
    ).toBe('traveller');

    expect(
      Reflect.getMetadata(
        ACCESS_LEVEL_KEY,
        ProfileController.prototype.getProfile,
      ),
    ).toBe('traveller');

    expect(
      Reflect.getMetadata(
        ACCESS_LEVEL_KEY,
        ProfileController.prototype.getOptions,
      ),
    ).toBe('public');
  });

  it('pins rate-limit buckets to all profile routes', () => {
    const expected: Record<string, RateLimitOptions> = {
      complete: { bucket: 'complete-profile', limit: 5, windowSeconds: 60 },
      getProfile: { bucket: 'get-profile', limit: 30, windowSeconds: 60 },
      getOptions: { bucket: 'profile-options', limit: 60, windowSeconds: 60 },
    };

    for (const [route, options] of Object.entries(expected)) {
      expect(
        Reflect.getMetadata(
          RATE_LIMIT_KEY,
          ProfileController.prototype[route as keyof ProfileController] as Function,
        ),
      ).toEqual(options);
    }
  });
});

