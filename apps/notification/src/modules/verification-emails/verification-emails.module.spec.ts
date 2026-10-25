import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_REGISTERED_VERSION,
  EVENT_TYPES,
  VERIFICATION_CODE_ISSUED_VERSION,
} from '@app/contracts';
import { producerTopology, type EventHandlerPort } from '@app/messaging';
import {
  ACCOUNT_REGISTERED_QUEUE,
  createVerificationEmailSubscriptions,
  VERIFICATION_EMAIL_QUEUE,
} from './verification-emails.module.js';

function tsFilesIn(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...tsFilesIn(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      // Identity's own specs assert that SMTP keys are absent from its schema,
      // so they name them. Scanning a test for a string it exists to forbid
      // reports the proof as the violation.
      !entry.endsWith('.spec.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

const identityFiles = tsFilesIn(join(process.cwd(), 'apps', 'identity', 'src'));

describe('Producers do not know their consumers', () => {
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

    const handlerPort = handler();
    const subscriptions = createVerificationEmailSubscriptions(
      handlerPort,
      handlerPort,
    );
    expect(subscriptions).toEqual([
      expect.objectContaining({
        eventType: EVENT_TYPES.verificationCodeIssued,
        version: VERIFICATION_CODE_ISSUED_VERSION,
        queueName: VERIFICATION_EMAIL_QUEUE,
      }),
      expect.objectContaining({
        eventType: EVENT_TYPES.accountRegistered,
        version: ACCOUNT_REGISTERED_VERSION,
        queueName: ACCOUNT_REGISTERED_QUEUE,
      }),
    ]);
  });

  it('gives each event its own queue so one backlog cannot starve the other', () => {
    const handlerPort = handler();
    const subscriptions = createVerificationEmailSubscriptions(
      handlerPort,
      handlerPort,
    );

    expect(subscriptions[0].queueName).not.toBe(subscriptions[1].queueName);
    expect(subscriptions[0].handler).toBe(subscriptions[1].handler);
  });

  it('builds an independent subscription list per call', () => {
    const handlerPort = handler();
    const first = createVerificationEmailSubscriptions(handlerPort, handlerPort);
    const second = createVerificationEmailSubscriptions(
      handlerPort,
      handlerPort,
    );

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[1]).not.toBe(second[1]);
  });
});

function handler(): EventHandlerPort {
  return {
    handle: async () => ({ status: 'handled' }),
  };
}
