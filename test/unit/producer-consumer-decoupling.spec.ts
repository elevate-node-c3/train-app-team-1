import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, VERIFICATION_CODE_ISSUED_VERSION } from '@app/contracts';
import { producerTopology, type EventHandlerPort } from '@app/messaging';
import {
  createVerificationEmailSubscriptions,
  VERIFICATION_EMAIL_QUEUE,
} from '../../apps/notification/src/modules/verification-emails/verification-emails.module.js';

function tsFilesIn(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...tsFilesIn(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const identityFiles = tsFilesIn(join(process.cwd(), 'apps', 'identity', 'src'));

describe('Producers do not know their consumers (ADR-0001, ADR-0007)', () => {
  it('keeps every email, SMTP and consumer concern out of identity', () => {
    const violations: string[] = [];
    const consumerOnly = [
      /nodemailer/i,
      /\bEventConsumerService\b/,
      /\bEMAIL_SENDER\b/,
      /\bEMAIL_DELIVERY_REPOSITORY\b/,
      /\bSMTP_[A-Z_]+\b/,
      /verification-emails/,
    ];

    for (const file of identityFiles) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of consumerOnly) {
        if (pattern.test(content)) {
          violations.push(`${file} matches ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('declares the consumer queue only on the consumer side', () => {
    expect(producerTopology().queues).toEqual([]);

    const subscriptions = createVerificationEmailSubscriptions(handler());
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      eventType: EVENT_TYPES.verificationCodeIssued,
      version: VERIFICATION_CODE_ISSUED_VERSION,
      queueName: VERIFICATION_EMAIL_QUEUE,
    });
  });

  it('builds an independent subscription list per call', () => {
    const first = createVerificationEmailSubscriptions(handler());
    const second = createVerificationEmailSubscriptions(handler());

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });
});

function handler(): EventHandlerPort {
  return {
    handle: async () => ({ status: 'handled' }),
  };
}
