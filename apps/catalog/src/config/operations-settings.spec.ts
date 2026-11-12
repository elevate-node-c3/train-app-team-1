import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import {
  inventoryGrpcUrl,
  isChargeableFare,
  seatUsageTimeoutMs,
  stripeMinimumChargePiastres,
  warnIfStripeFloorUnconfigured,
} from './operations-settings.js';

const ENV_VAR = 'STRIPE_MINIMUM_CHARGE_PIASTRES';
const TIMEOUT_ENV_VAR = 'INVENTORY_SEAT_USAGE_TIMEOUT_MS';
const URL_ENV_VAR = 'INVENTORY_GRPC_URL';

describe('operations-settings', () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalValue;
  });

  describe('stripeMinimumChargePiastres', () => {
    it('returns the configured floor', () => {
      process.env[ENV_VAR] = '600';
      expect(stripeMinimumChargePiastres()).toBe(600);
    });

    it('falls back to a floor of 1 piastre when unconfigured', () => {
      expect(stripeMinimumChargePiastres()).toBe(1);
    });

    it('throws naming the variable when the value is not a positive integer', () => {
      for (const invalid of ['0', '-5', 'abc', '12.5']) {
        process.env[ENV_VAR] = invalid;
        expect(() => stripeMinimumChargePiastres()).toThrow(ENV_VAR);
      }
    });
  });

  describe('isChargeableFare', () => {
    it('accepts a fare at the configured floor', () => {
      process.env[ENV_VAR] = '600';
      expect(isChargeableFare(600)).toBe(true);
    });

    it('refuses a fare one piastre below the floor', () => {
      process.env[ENV_VAR] = '600';
      expect(isChargeableFare(599)).toBe(false);
    });

    it('refuses zero and negative fares', () => {
      process.env[ENV_VAR] = '600';
      expect(isChargeableFare(0)).toBe(false);
      expect(isChargeableFare(-1)).toBe(false);
    });

    it('refuses a non-integer fare', () => {
      process.env[ENV_VAR] = '600';
      expect(isChargeableFare(600.5)).toBe(false);
    });

    it('refuses only non-positive fares when the floor is unconfigured', () => {
      expect(isChargeableFare(1)).toBe(true);
      expect(isChargeableFare(0)).toBe(false);
      expect(isChargeableFare(-1)).toBe(false);
    });
  });

  describe('warnIfStripeFloorUnconfigured', () => {
    function stubLogger(): LoggerService {
      return {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as LoggerService;
    }

    it('warns once when the floor is unconfigured', () => {
      const logger = stubLogger();
      warnIfStripeFloorUnconfigured(logger);
      warnIfStripeFloorUnconfigured(logger);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(ENV_VAR));
    });

    it('stays silent when the floor is configured', () => {
      process.env[ENV_VAR] = '600';
      const logger = stubLogger();
      warnIfStripeFloorUnconfigured(logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('seatUsageTimeoutMs', () => {
    let originalTimeout: string | undefined;

    beforeEach(() => {
      originalTimeout = process.env[TIMEOUT_ENV_VAR];
      delete process.env[TIMEOUT_ENV_VAR];
    });

    afterEach(() => {
      if (originalTimeout === undefined) delete process.env[TIMEOUT_ENV_VAR];
      else process.env[TIMEOUT_ENV_VAR] = originalTimeout;
    });

    it('returns the configured timeout', () => {
      process.env[TIMEOUT_ENV_VAR] = '5000';
      expect(seatUsageTimeoutMs()).toBe(5000);
    });

    it('falls back to 2000ms when unconfigured', () => {
      expect(seatUsageTimeoutMs()).toBe(2000);
    });

    it('throws naming the variable when the value is not a positive integer', () => {
      for (const invalid of ['0', '-5', 'abc', '12.5']) {
        process.env[TIMEOUT_ENV_VAR] = invalid;
        expect(() => seatUsageTimeoutMs()).toThrow(TIMEOUT_ENV_VAR);
      }
    });
  });

  describe('inventoryGrpcUrl', () => {
    let originalUrl: string | undefined;

    beforeEach(() => {
      originalUrl = process.env[URL_ENV_VAR];
    });

    afterEach(() => {
      if (originalUrl === undefined) delete process.env[URL_ENV_VAR];
      else process.env[URL_ENV_VAR] = originalUrl;
    });

    it('returns the configured url', () => {
      process.env[URL_ENV_VAR] = 'inventory-staging:9000';
      expect(inventoryGrpcUrl()).toBe('inventory-staging:9000');
    });

    it('falls back to inventory:50051 when unset', () => {
      delete process.env[URL_ENV_VAR];
      expect(inventoryGrpcUrl()).toBe('inventory:50051');
    });

    // A blank .env value must not become an empty host.
    it('falls back when the value is blank', () => {
      process.env[URL_ENV_VAR] = '   ';
      expect(inventoryGrpcUrl()).toBe('inventory:50051');
    });
  });
});
