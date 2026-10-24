import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_OUTBOX_SQL,
  INSERT_OUTBOX_SQL,
  MARK_OUTBOX_PUBLISHED_SQL,
  RECORD_OUTBOX_FAILURE_SQL,
} from '@app/messaging';
import {
  CLAIM_PROCESSED_EVENT_SQL,
  MARK_PROCESSED_EVENT_FAILED_SQL,
  MARK_PROCESSED_EVENT_HANDLED_SQL,
  MARK_PROCESSED_EVENT_SKIPPED_SQL,
} from '@app/messaging/consumer/processed-event.sql.js';
import { EMAIL_DELIVERY_OUTCOMES } from '../../apps/notification/src/modules/verification-emails/application/ports/email-delivery.repository.port.js';
import { INSERT_EMAIL_DELIVERY_SQL } from '../../apps/notification/src/modules/verification-emails/infrastructure/persistence/email-delivery.sql.js';

const identityDdl = readFileSync(
  'apps/identity/src/database/migrations/1761314400000-create-accounts-verification-codes-outbox.ts',
  'utf8',
);
const notificationDdl = readFileSync(
  'apps/notification/src/database/migrations/1761314500000-create-processed-event-email-delivery.ts',
  'utf8',
);

/**
 * Extracts the text between `CREATE TABLE <name> (` and its matching `)`.
 * A plain regex cannot do this because the bodies contain nested CHECK (...).
 */
function tableBody(ddl: string, table: string): string {
  const marker = `CREATE TABLE ${table} (`;
  const start = ddl.indexOf(marker);
  if (start < 0) {
    throw new Error(`No CREATE TABLE for ${table}`);
  }

  let depth = 0;
  let body = '';
  for (let index = start + marker.length; index < ddl.length; index += 1) {
    const character = ddl[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      if (depth === 0) return body;
      depth -= 1;
    }
    body += character;
  }
  throw new Error(`Unterminated CREATE TABLE for ${table}`);
}

function columnsOf(ddl: string, table: string): string[] {
  const columns = new Set<string>();
  for (const line of tableBody(ddl, table).split('\n')) {
    const match = line
      .trim()
      .match(
        /^([a-z_][a-z0-9_]*)\s+(?:uuid|text|integer|timestamptz|jsonb|boolean|numeric)\b/,
      );
    if (match) columns.add(match[1]);
  }
  return [...columns];
}

/**
 * The columns a statement mentions, not every identifier in it: SQL keywords,
 * `now()` and the status literals would otherwise drown the signal. This is
 * enough to catch the real failure — an adapter statement naming a column the
 * migration never created.
 */
function referencedColumns(sql: string, table: string): Set<string> {
  const found = new Set<string>();

  for (const match of sql.matchAll(
    new RegExp(`\\b${table}\\.([a-z_][a-z0-9_]*)`, 'g'),
  )) {
    found.add(match[1]);
  }

  const insert = sql.match(
    new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`, 'i'),
  );
  if (insert) {
    for (const column of insert[1].split(',')) found.add(column.trim());
  }

  const select = sql.match(new RegExp(`SELECT([\\s\\S]*?)FROM\\s+${table}`, 'i'));
  if (select) {
    for (const expression of select[1].split(',')) {
      const column = expression.trim().match(/^([a-z_][a-z0-9_]*)$/);
      if (column) found.add(column[1]);
    }
  }

  const update = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i);
  if (update) {
    for (const match of update[1].matchAll(/([a-z_][a-z0-9_]*)\s*=/g)) {
      found.add(match[1]);
    }
  }

  for (const match of sql.matchAll(/\bRETURNING\s+([a-z_][a-z0-9_]*)/gi)) {
    found.add(match[1]);
  }

  return found;
}

describe('Schema agreement (ADR-0001, ADR-0003, ADR-0006)', () => {
  it('gives every processed_event statement a column the migration creates', () => {
    const columns = new Set(columnsOf(notificationDdl, 'processed_event'));
    const referenced = new Set<string>();
    for (const sql of [
      CLAIM_PROCESSED_EVENT_SQL,
      MARK_PROCESSED_EVENT_HANDLED_SQL,
      MARK_PROCESSED_EVENT_SKIPPED_SQL,
      MARK_PROCESSED_EVENT_FAILED_SQL,
    ]) {
      for (const column of referencedColumns(sql, 'processed_event')) {
        referenced.add(column);
      }
    }

    expect(referenced.size).toBeGreaterThanOrEqual(8);
    expect([...referenced].filter((column) => !columns.has(column))).toEqual(
      [],
    );
  });

  it('makes event_id the processed_event primary key', () => {
    expect(tableBody(notificationDdl, 'processed_event')).toMatch(
      /event_id uuid PRIMARY KEY/,
    );
  });

  it('indexes only processing rows, not the whole ledger', () => {
    expect(notificationDdl).toMatch(
      /CREATE INDEX idx_processed_event_processing[\s\S]*?WHERE status = 'processing'/,
    );
  });

  it('gives every outbox statement a column the identity migration creates', () => {
    const columns = new Set(columnsOf(identityDdl, 'outbox_event'));
    const referenced = new Set<string>();
    for (const sql of [
      INSERT_OUTBOX_SQL,
      CLAIM_OUTBOX_SQL,
      MARK_OUTBOX_PUBLISHED_SQL,
      RECORD_OUTBOX_FAILURE_SQL,
    ]) {
      for (const column of referencedColumns(sql, 'outbox_event')) {
        referenced.add(column);
      }
    }

    expect(referenced.size).toBeGreaterThanOrEqual(12);
    expect([...referenced].filter((column) => !columns.has(column))).toEqual(
      [],
    );
  });

  it('keeps the relay index partial on unpublished rows', () => {
    expect(identityDdl).toMatch(
      /CREATE INDEX idx_outbox_event_unpublished[\s\S]*?WHERE published_at IS NULL/,
    );
  });

  it('gives the email_delivery insert a column the migration creates', () => {
    const columns = new Set(columnsOf(notificationDdl, 'email_delivery'));
    const referenced = referencedColumns(
      INSERT_EMAIL_DELIVERY_SQL,
      'email_delivery',
    );

    expect(referenced.size).toBeGreaterThanOrEqual(10);
    expect([...referenced].filter((column) => !columns.has(column))).toEqual(
      [],
    );
  });

  it('keeps the delivery outcomes in sync with the migration CHECK', () => {
    const body = tableBody(notificationDdl, 'email_delivery');

    expect(EMAIL_DELIVERY_OUTCOMES).toEqual([
      'accepted',
      'skipped_expired',
      'failed',
    ]);
    for (const outcome of EMAIL_DELIVERY_OUTCOMES) {
      expect(body).toContain(`'${outcome}'`);
    }
  });

  it('never gives notification a column that could hold the code or a secret', () => {
    const columns = [
      ...columnsOf(notificationDdl, 'processed_event'),
      ...columnsOf(notificationDdl, 'email_delivery'),
    ];

    expect(columns.filter((column) => /code|secret|token/i.test(column))).toEqual(
      [],
    );
  });

  it('keeps the plaintext out of identity: only hash and salt are columns', () => {
    const columns = columnsOf(identityDdl, 'verification_code');

    expect(columns).toEqual(
      expect.arrayContaining(['code_hash', 'code_salt']),
    );
    expect(columns).not.toContain('code');
    expect(columnsOf(identityDdl, 'outbox_event')).not.toContain('code');
  });

  it('lets a duplicate email be a second row: event_id is not unique', () => {
    expect(tableBody(notificationDdl, 'email_delivery')).not.toMatch(
      /event_id[^,\n]*UNIQUE/i,
    );
    expect(notificationDdl).not.toMatch(
      /CREATE UNIQUE INDEX[^;]*email_delivery[^;]*event_id/i,
    );
    expect(notificationDdl).toMatch(
      /CREATE INDEX idx_email_delivery_event_id[\s\S]*?ON email_delivery \(event_id\)/,
    );
  });

  it('requires accepted rows to carry the BR-03 measurement', () => {
    expect(tableBody(notificationDdl, 'email_delivery')).toMatch(
      /outcome <> 'accepted'[\s\S]*?accepted_at IS NOT NULL AND latency_ms IS NOT NULL/,
    );
  });
});
