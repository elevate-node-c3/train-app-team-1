import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { OperationsRequestEntity } from './entities/operations-request.entity.js';
import type { StoredOperationsRequest } from './operations-request.types.js';

/**
 * Keyed by the client's `Idempotency-Key` (TA-20). `record` takes the
 * caller's transaction, with no overload that opens its own: the key must
 * commit in the same transaction as the change it names, or a crash between
 * commit and response would lose it and a retry would apply the change
 * twice. This mirrors `OperationsAuditRepository.append`, for the same
 * reason.
 */
@Injectable()
export class OperationsRequestRepository {
  constructor(private readonly dataSource: DataSource) {}

  async find(idempotencyKey: string): Promise<StoredOperationsRequest | null> {
    const row = await this.dataSource
      .getRepository(OperationsRequestEntity)
      .findOne({ where: { idempotencyKey } });
    if (!row) return null;

    return {
      idempotencyKey: row.idempotencyKey,
      fingerprint: row.fingerprint,
      responseJson: row.responseJson,
    };
  }

  async record(
    ctx: TransactionContext,
    request: StoredOperationsRequest,
  ): Promise<void> {
    const repository = entityManagerOf(ctx).getRepository(
      OperationsRequestEntity,
    );
    const entity = new OperationsRequestEntity();
    entity.idempotencyKey = request.idempotencyKey;
    entity.fingerprint = request.fingerprint;
    entity.responseJson = request.responseJson;
    // insert, not save: save checks for an existing row and silently turns
    // a reused key into an UPDATE. A reused key with different content is a
    // client bug (see fingerprintOf's doc comment), and only a plain INSERT
    // lets the primary key reject it.
    await repository.insert(entity);
  }
}

/**
 * A SHA-256 of `payload`, stable across key order but sensitive to any
 * value. Object keys are sorted recursively before serialising; array
 * **order** is left alone, because a timetable's stops are an ordered list
 * and reordering them is a different request.
 *
 * A key present with `undefined` and an absent key serialise the same way:
 * `JSON.stringify` drops an `undefined`-valued object property, which is
 * exactly the equivalence this fingerprint should have too.
 */
export function fingerprintOf(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortedKeys(payload)))
    .digest('hex');
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortedKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
