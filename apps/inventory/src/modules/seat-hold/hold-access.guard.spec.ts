import type { ExecutionContext } from '@nestjs/common';
import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { SchemaReadinessGate } from '@app/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoldCreationGuard, HoldServiceGuard } from './hold-access.guard.js';
import { SeatHoldGrpcController } from './seat-hold.grpc.controller.js';

const key = 'booking-inventory-test-credential-long-enough';
const context = (metadata: Metadata) =>
  ({ switchToRpc: () => ({ getContext: () => metadata }) }) as ExecutionContext;
afterEach(() => vi.unstubAllEnvs());

function creationGuard(completed = true) {
  const query = vi.fn(async () => [{ needsBackfill: false }]);
  const initializer = { ensureInitialized: vi.fn(async () => ({ query })) };
  return {
    query,
    initializer,
    guard: new HoldCreationGuard(
      initializer as never,
      new SchemaReadinessGate(),
      { hasCompleted: completed } as never,
    ),
  };
}

describe('private Inventory hold admission', () => {
  it('requires one purpose-specific Booking credential before domain work', () => {
    vi.stubEnv('BOOKING_INVENTORY_SERVICE_KEY', key);
    const metadata = new Metadata();
    expect(() => new HoldServiceGuard().canActivate(context(metadata))).toThrow(
      RpcException,
    );
    metadata.set('x-booking-inventory-key', key);
    expect(new HoldServiceGuard().canActivate(context(metadata))).toBe(true);
    metadata.add('x-booking-inventory-key', key);
    expect(() => new HoldServiceGuard().canActivate(context(metadata))).toThrow(
      RpcException,
    );
  });

  it('fails closed when a key is absent or belongs to the Identity boundary', () => {
    vi.stubEnv('BOOKING_INVENTORY_SERVICE_KEY', key);
    const metadata = new Metadata();
    metadata.set('x-booking-identity-key', key);
    expect(() => new HoldServiceGuard().canActivate(context(metadata))).toThrow(
      RpcException,
    );
    vi.stubEnv('BOOKING_INVENTORY_SERVICE_KEY', '');
    metadata.set('x-booking-inventory-key', '');
    expect(() => new HoldServiceGuard().canActivate(context(metadata))).toThrow(
      RpcException,
    );
  });

  it('keeps new creation disabled until explicitly enabled and ready', async () => {
    const { guard, query } = creationGuard();
    vi.stubEnv('HOLD_CREATION_ENABLED', 'false');
    await expect(guard.canActivate()).rejects.toBeInstanceOf(RpcException);
    expect(query).not.toHaveBeenCalled();
    vi.stubEnv('HOLD_CREATION_ENABLED', 'true');
    await expect(guard.canActivate()).resolves.toBe(true);
  });

  it('refuses activation until live anonymous occupations are authoritatively backfilled', async () => {
    vi.stubEnv('HOLD_CREATION_ENABLED', 'true');
    const { guard, query } = creationGuard();
    query.mockResolvedValueOnce([{ needsBackfill: true }]);
    await expect(guard.canActivate()).rejects.toBeInstanceOf(RpcException);
    await expect(guard.canActivate()).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does no database work after a migration failure', async () => {
    vi.stubEnv('HOLD_CREATION_ENABLED', 'true');
    const { guard, initializer } = creationGuard(false);
    await expect(guard.canActivate()).rejects.toBeInstanceOf(RpcException);
    expect(initializer.ensureInitialized).not.toHaveBeenCalled();
  });

  it('sanitizes a failed readiness query without leaking identity values', async () => {
    vi.stubEnv('HOLD_CREATION_ENABLED', 'true');
    const { guard, query } = creationGuard();
    query.mockRejectedValueOnce(
      new Error('SQL passenger_token=private-token nationalId=29801011234567'),
    );
    try {
      await guard.canActivate();
      throw new Error('expected refusal');
    } catch (error) {
      expect((error as RpcException).getError()).toEqual({
        code: status.UNAVAILABLE,
        details: JSON.stringify({ code: 'SERVICE_UNAVAILABLE' }),
        // The code is the message; the edge resolves the caller's language.
        message: 'SERVICE_UNAVAILABLE',
      });
      expect(JSON.stringify(error)).not.toContain('private');
      expect(JSON.stringify(error)).not.toContain('29801011234567');
    }
  });

  it('protects all hold RPCs but applies creation gating only to new ownership', () => {
    expect(Reflect.getMetadata('__guards__', SeatHoldGrpcController)).toContain(
      HoldServiceGuard,
    );
    expect(
      Reflect.getMetadata(
        '__guards__',
        SeatHoldGrpcController.prototype.createHold,
      ),
    ).toContain(HoldCreationGuard);
    expect(
      Reflect.getMetadata(
        '__guards__',
        SeatHoldGrpcController.prototype.releaseHold,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        '__guards__',
        SeatHoldGrpcController.prototype.extendHold,
      ),
    ).toBeUndefined();
  });
});
