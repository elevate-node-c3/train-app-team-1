import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import {
  isChargeableFare,
  stripeMinimumChargePiastres,
  warnIfStripeFloorUnconfigured,
} from './operations-settings.js';

const ENV_VAR = 'STRIPE_MINIMUM_CHARGE_PIASTRES';

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
});
