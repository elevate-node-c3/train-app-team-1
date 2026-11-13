import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, HTTP_STATUS_BY_ERROR_CODE } from '@app/contracts';
import { MESSAGE_CATALOGUE } from '@app/common';
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
import { EMAIL_DELIVERY_OUTCOMES } from '../../apps/notification/src/modules/verification-emails/email-delivery.types.js';

const identityDdl = readFileSync(
  'apps/identity/src/database/migrations/1761314400000-create-accounts-verification-codes-outbox.ts',
  'utf8',
);
const notificationDdl = readFileSync(
  'apps/notification/src/database/migrations/1761314500000-create-processed-event-email-delivery.ts',
  'utf8',
);
const catalogOutboxDdl = readFileSync(
  'apps/catalog/src/database/migrations/1793300000004-create-catalog-outbox.ts',
  'utf8',
);

/** Every relaying service owns `outbox_event`; each copy must match the shared SQL. */
const outboxDdls: [string, string][] = [
  ['identity', identityDdl],
  ['catalog', catalogOutboxDdl],
];

const catalogProcessedEventDdl = readFileSync(
  'apps/catalog/src/database/migrations/1793300000005-create-catalog-processed-event.ts',
  'utf8',
);

/**
 * Each consumer's `processed_event` must match the shared claim SQL.
 * A missing table dead-letters catalog deliveries.
 */
const processedEventDdls: [string, string][] = [
  ['notification', notificationDdl],
  ['catalog', catalogProcessedEventDdl],
];
const emailDeliveryEntitySource = readFileSync(
  'apps/notification/src/modules/verification-emails/entities/email-delivery.entity.ts',
  'utf8',
);

/** Track nested CHECK parentheses to find the table body's closing parenthesis. */
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
 * Read source, not TypeORM metadata, to catch decorator typos.
 * Use the explicit column name or the property name. The regex backtracks over
 * `default: () => 'now()'` to find the decorator's closing parenthesis.
 */
function entityColumnsOf(source: string): string[] {
  const columns: string[] = [];
  for (const match of source.matchAll(
    /@(?:PrimaryColumn|Column)\(([\s\S]*?)\)\s*([A-Za-z_$][\w$]*)\s*!/g,
  )) {
    const decoratedOptions = match[1];
    const property = match[2];
    const named = decoratedOptions.match(/\bname:\s*['"]([^'"]+)['"]/);
    columns.push(named?.[1] ?? property);
  }
  return columns;
}

/**
 * Collect column references, not SQL keywords, functions or status values,
 * to catch statements that name columns missing from the migration.
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

  const select = sql.match(
    new RegExp(`SELECT([\\s\\S]*?)FROM\\s+${table}`, 'i'),
  );
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

describe('Schema agreement', () => {
  it.each(processedEventDdls)(
    'gives every processed_event statement a column the %s migration creates',
    (_service, ddl) => {
      const columns = new Set(columnsOf(ddl, 'processed_event'));
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
    },
  );

  it.each(processedEventDdls)(
    'makes event_id the %s processed_event primary key',
    (_service, ddl) => {
      expect(tableBody(ddl, 'processed_event')).toMatch(
        /event_id uuid PRIMARY KEY/,
      );
    },
  );

  it.each(processedEventDdls)(
    'indexes only processing rows of %s, not the whole ledger',
    (_service, ddl) => {
      expect(ddl).toMatch(
        /CREATE INDEX idx_processed_event_processing[\s\S]*?WHERE status = 'processing'/,
      );
    },
  );

  it('gives both processed_event tables the same columns', () => {
    const [[, notification], [, catalog]] = processedEventDdls;

    expect(columnsOf(catalog, 'processed_event').sort()).toEqual(
      columnsOf(notification, 'processed_event').sort(),
    );
  });

  it('gives every service that consumes events its own inbox table', () => {
    // Catalog's four event types all need this table to avoid dead-lettering.
    const consumers = [
      'apps/catalog/src/database/migrations',
      'apps/notification/src/database/migrations',
    ];

    for (const directory of consumers) {
      const created = readdirSync(directory).some((file) =>
        readFileSync(`${directory}/${file}`, 'utf8').includes(
          'CREATE TABLE processed_event',
        ),
      );

      expect(created, `${directory} creates processed_event`).toBe(true);
    }
  });

  it.each(outboxDdls)(
    'gives every outbox statement a column the %s migration creates',
    (_service, ddl) => {
      const columns = new Set(columnsOf(ddl, 'outbox_event'));
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
    },
  );

  it.each(outboxDdls)(
    'keeps the %s relay index partial on unpublished rows',
    (_service, ddl) => {
      expect(ddl).toMatch(
        /CREATE INDEX idx_outbox_event_unpublished[\s\S]*?WHERE published_at IS NULL/,
      );
    },
  );

  it('gives both outbox tables the same columns', () => {
    const [[, identity], [, catalog]] = outboxDdls;

    expect(columnsOf(catalog, 'outbox_event').sort()).toEqual(
      columnsOf(identity, 'outbox_event').sort(),
    );
  });

  it('gives the email_delivery entity exactly the columns the migration creates', () => {
    const migrationColumns = new Set(
      columnsOf(notificationDdl, 'email_delivery'),
    );
    const entityColumns = entityColumnsOf(emailDeliveryEntitySource);

    expect(emailDeliveryEntitySource).toMatch(/@Entity\('email_delivery'\)/);
    expect(entityColumns).toHaveLength(12);
    expect(
      entityColumns.filter((column) => !migrationColumns.has(column)),
    ).toEqual([]);
    expect(
      [...migrationColumns].filter((column) => !entityColumns.includes(column)),
    ).toEqual([]);
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

    expect(
      columns.filter((column) => /code|secret|token/i.test(column)),
    ).toEqual([]);
  });

  it('keeps the plaintext out of identity: only hash and salt are columns', () => {
    const columns = columnsOf(identityDdl, 'verification_code');

    expect(columns).toEqual(expect.arrayContaining(['code_hash', 'code_salt']));
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

describe('Passenger error codes and messages', () => {
  it('defines HTTP status mappings for passenger error codes', () => {
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.PASSENGER_NOT_FOUND]).toBe(404);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.PASSENGER_LIMIT_REACHED]).toBe(422);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.CANNOT_DELETE_SELF_PASSENGER]).toBe(422);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.NATIONAL_ID_LOCKED]).toBe(422);
  });

  it('defines bilingual error messages in catalogue for passenger error codes', () => {
    expect(MESSAGE_CATALOGUE[ErrorCode.PASSENGER_NOT_FOUND]).toEqual({
      ar: 'المسافر غير موجود',
      en: 'Passenger not found',
    });
    expect(MESSAGE_CATALOGUE[ErrorCode.PASSENGER_LIMIT_REACHED]).toEqual({
      ar: 'تم الوصول إلى الحد الأقصى للمسافرين (10 مسافرين)',
      en: 'Passenger limit reached (maximum 10 companions)',
    });
    expect(MESSAGE_CATALOGUE[ErrorCode.CANNOT_DELETE_SELF_PASSENGER]).toEqual({
      ar: 'لا يمكن حذف المسافر الأساسي',
      en: 'Cannot delete self passenger',
    });
    expect(MESSAGE_CATALOGUE[ErrorCode.NATIONAL_ID_LOCKED]).toEqual({
      ar: 'لا يمكن تعديل الرقم القومي بعد إصدار التذكرة',
      en: 'National ID cannot be changed once a ticket has been issued',
    });
  });
});
