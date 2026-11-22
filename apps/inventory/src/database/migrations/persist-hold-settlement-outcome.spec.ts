import { describe, expect, it, vi } from 'vitest';
import { PersistHoldSettlementOutcome1797400000001 } from './1797400000001-persist-hold-settlement-outcome.js';

describe('PersistHoldSettlementOutcome migration', () => {
  it('backfills existing sold heads before requiring a consistent decision', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await new PersistHoldSettlementOutcome1797400000001().up({
      query,
    } as never);
    const sql = query.mock.calls.map(([statement]) => statement);
    expect(sql[0]).toContain('ADD COLUMN "settlement_outcome"');
    expect(sql[1]).toContain(`SET "settlement_outcome" = 'SOLD'`);
    expect(sql[1]).toContain(`WHERE "state" = 'sold'`);
    expect(sql[2]).toContain('chk_seat_hold_group_settlement_state');
  });

  it('refuses rollback while any durable sale or refusal exists', async () => {
    const query = vi.fn().mockResolvedValue([{ hasSettlements: true }]);
    await expect(
      new PersistHoldSettlementOutcome1797400000001().down({ query } as never),
    ).rejects.toThrow('Cannot remove durable settlement decisions');
    expect(query).toHaveBeenCalledOnce();
  });

  it('allows rollback only before a settlement has been recorded', async () => {
    const query = vi.fn().mockResolvedValue([{ hasSettlements: false }]);
    await new PersistHoldSettlementOutcome1797400000001().down({
      query,
    } as never);
    expect(query.mock.calls[1][0]).toContain(
      'DROP COLUMN "settlement_outcome"',
    );
  });
});
