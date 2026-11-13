import { ErrorCode } from '@app/contracts';
import { CALLER_ACCOUNT_ID_KEY } from '@app/common';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';

import { RecentSearchesGrpcController } from './recent-searches.grpc.controller.js';
import type { RecentSearchesService } from './recent-searches.service.js';

const TRAVELLER = '44444444-4444-4444-8444-444444444444';

/** A CLS stub holding whatever the gateway's metadata would have set. */
function clsWith(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function controllerWith(
  service: Partial<RecentSearchesService>,
  values: Record<string, unknown> = { [CALLER_ACCOUNT_ID_KEY]: TRAVELLER },
) {
  return new RecentSearchesGrpcController(
    service as RecentSearchesService,
    clsWith(values) as never,
  );
}

describe('the recent-searches gRPC controller', () => {
  it('reads the traveller from caller metadata and captures the instant', async () => {
    const list = vi.fn().mockResolvedValue({ recentSearches: [] });
    const before = Date.now();

    await controllerWith({ list }).listRecentSearches();

    expect(list.mock.calls[0][0]).toBe(TRAVELLER);
    const now = list.mock.calls[0][1] as Date;
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns what the service answers', async () => {
    const response = { recentSearches: [] };
    const list = vi.fn().mockResolvedValue(response);

    await expect(controllerWith({ list }).listRecentSearches()).resolves.toBe(
      response,
    );
  });

  /** Refuse unidentified callers instead of claiming they have no recent searches. */
  describe('without a caller', () => {
    it('refuses as UNAUTHENTICATED', async () => {
      const list = vi.fn();

      const error = await controllerWith({ list }, {})
        .listRecentSearches()
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        code: number;
        details: string;
      };
      expect(payload.code).toBe(grpc.status.UNAUTHENTICATED);
      expect(JSON.parse(payload.details).code).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('does not read anybody else', async () => {
      const list = vi.fn();

      await controllerWith({ list }, {})
        .listRecentSearches()
        .catch(() => undefined);

      expect(list).not.toHaveBeenCalled();
    });
  });
});
