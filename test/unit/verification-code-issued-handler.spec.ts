import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventEnvelope,
  VerificationCodeIssuedPayloadV1,
} from '@app/contracts';
import {
  VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VERIFICATION_CODE_ISSUED_VERSION,
} from '@app/contracts';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';
import {
  type EmailDeliveryRecord,
  type EmailDeliveryRepositoryPort,
} from '../../apps/notification/src/modules/verification-emails/application/ports/email-delivery.repository.port.js';
import {
  type EmailSenderPort,
  type OutboundEmail,
} from '../../apps/notification/src/modules/verification-emails/application/ports/email-sender.port.js';
import { HandleVerificationCodeIssuedUseCase } from '../../apps/notification/src/modules/verification-emails/application/use-cases/handle-verification-code-issued.use-case.js';
import { parseVerificationCodeIssuedPayload } from '../../apps/notification/src/modules/verification-emails/application/verification-code-issued.parser.js';
import { renderVerificationEmail } from '../../apps/notification/src/modules/verification-emails/application/verification-email.template.js';
import { NodemailerEmailSender } from '../../apps/notification/src/modules/verification-emails/infrastructure/email/nodemailer-email-sender.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-24T10:10:00.000Z');
const CODE = '483920';
const EMAIL = 'user@example.com';

const createTransportMock = vi.hoisted(() => vi.fn());

vi.mock('nodemailer', () => ({
  createTransport: createTransportMock,
}));

function event(
  payload: Partial<VerificationCodeIssuedPayloadV1> = {},
): EventEnvelope {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: VERIFICATION_CODE_ISSUED_EVENT_TYPE,
    version: VERIFICATION_CODE_ISSUED_VERSION,
    occurredAt: NOW.toISOString(),
    correlationId: 'corr-1',
    producer: 'identity',
    payload: {
      accountId: '22222222-2222-4222-8222-222222222222',
      email: EMAIL,
      code: CODE,
      purpose: 'sign_up',
      language: 'en',
      issuedAt: NOW.toISOString(),
      expiresAt: EXPIRES_AT.toISOString(),
      ...payload,
    },
  };
}

interface Harness {
  handler: HandleVerificationCodeIssuedUseCase;
  sent: OutboundEmail[];
  recorded: EmailDeliveryRecord[];
}

function harness(options: { sendError?: Error } = {}): Harness {
  const sent: OutboundEmail[] = [];
  const recorded: EmailDeliveryRecord[] = [];

  const emails: EmailSenderPort = {
    send: async (email) => {
      if (options.sendError) throw options.sendError;
      sent.push(email);
    },
  };
  const deliveries: EmailDeliveryRepositoryPort = {
    record: async (delivery) => {
      recorded.push(delivery);
    },
  };

  return {
    handler: new HandleVerificationCodeIssuedUseCase(emails, deliveries),
    sent,
    recorded,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  createTransportMock.mockReset();
});

describe('Verification-code issued parser (ADR-0005, ADR-0006)', () => {
  it('parses every required field of a valid payload', () => {
    expect(parseVerificationCodeIssuedPayload(event())).toEqual(
      event().payload,
    );
  });

  it('accepts an additive field instead of rejecting the event', () => {
    const envelope = event();
    (envelope.payload as Record<string, unknown>).unexpected = 'ignored';

    expect(parseVerificationCodeIssuedPayload(envelope).code).toBe(CODE);
  });

  it('coerces an unknown language to Arabic rather than dead-lettering', () => {
    const parsed = parseVerificationCodeIssuedPayload(
      event({ language: 'fr' as VerificationCodeIssuedPayloadV1['language'] }),
    );

    expect(parsed.language).toBe('ar');
  });

  it('rejects a payload missing any required field, without echoing a value', () => {
    for (const key of [
      'accountId',
      'email',
      'code',
      'purpose',
      'language',
      'issuedAt',
      'expiresAt',
    ]) {
      const envelope = event();
      delete (envelope.payload as Record<string, unknown>)[key];

      let caught: unknown;
      try {
        parseVerificationCodeIssuedPayload(envelope);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidEventPayloadError);
      const message = (caught as Error).message;
      expect(message).toContain(key);
      expect(message).not.toContain(CODE);
      expect(message).not.toContain(EMAIL);
    }
  });

  it.each([
    ['accountId', 42],
    ['email', ''],
    ['email', 'not-an-email'],
    ['code', 483920],
    ['purpose', 'reset_password'],
    ['issuedAt', 'yesterday'],
    ['expiresAt', 'not-a-date'],
  ])('rejects an invalid %s', (key, value) => {
    const envelope = event();
    (envelope.payload as Record<string, unknown>)[key] = value;

    expect(() => parseVerificationCodeIssuedPayload(envelope)).toThrow(
      InvalidEventPayloadError,
    );
  });

  it('rejects an expiry that is not after issuance', () => {
    expect(() =>
      parseVerificationCodeIssuedPayload(
        event({ expiresAt: NOW.toISOString() }),
      ),
    ).toThrow(InvalidEventPayloadError);
  });
});

describe('Verification email template (BR-56)', () => {
  it('keeps the code in the body and out of the subject', () => {
    const content = renderVerificationEmail({ code: CODE, language: 'en' });

    expect(content.subject).not.toContain(CODE);
    expect(content.text).toContain(CODE);
    expect(content.html).toContain(CODE);
  });

  it('falls back to Arabic for an unsupported language', () => {
    expect(renderVerificationEmail({ code: CODE, language: 'fr' })).toEqual(
      renderVerificationEmail({ code: CODE, language: 'ar' }),
    );
  });
});

describe('Verification-code issued handler (BR-03, BR-54, BR-56, ADR-0003)', () => {
  it('sends the English email and records the accepted latency', async () => {
    const { handler, sent, recorded } = harness();
    vi.setSystemTime(NOW.getTime() + 2_000);

    await expect(handler.handle(event(), 1)).resolves.toEqual({
      status: 'handled',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: EMAIL,
      subject: 'Your Train verification code',
    });
    expect(sent[0].text).toContain(CODE);
    expect(sent[0].subject).not.toContain(CODE);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventId: event().id,
      accountId: '22222222-2222-4222-8222-222222222222',
      recipientEmail: EMAIL,
      purpose: 'sign_up',
      outcome: 'accepted',
      issuedAt: NOW,
      acceptedAt: new Date(NOW.getTime() + 2_000),
      latencyMs: 2_000,
    });
    // The delivery log is a measurement, never a place a live code can land.
    expect(JSON.stringify(recorded[0])).not.toContain(CODE);
  });

  it('renders Arabic for an Arabic account', async () => {
    const { handler, sent } = harness();

    await handler.handle(event({ language: 'ar' }), 1);

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('رمز التحقق الخاص بك في Train');
    expect(sent[0].text).toContain(CODE);
  });

  it('sends nothing once the code has expired and records the skip', async () => {
    const { handler, sent, recorded } = harness();
    vi.setSystemTime(EXPIRES_AT);

    await expect(handler.handle(event(), 1)).resolves.toEqual({
      status: 'skipped',
      skipReason: 'code_expired',
    });

    expect(sent).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      outcome: 'skipped_expired',
      skipReason: 'code_expired',
    });
  });

  it('records a failed send and rethrows so the consumer retries', async () => {
    const failure = new Error('smtp refused the message');
    const { handler, sent, recorded } = harness({ sendError: failure });

    await expect(handler.handle(event(), 1)).rejects.toBe(failure);

    expect(sent).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      outcome: 'failed',
      errorMessage: 'smtp refused the message',
    });
  });

  it('treats an unreadable payload as permanent and touches neither port', async () => {
    const envelope = event();
    delete (envelope.payload as Record<string, unknown>).code;
    const { handler, sent, recorded } = harness();

    await expect(handler.handle(envelope, 1)).rejects.toBeInstanceOf(
      InvalidEventPayloadError,
    );

    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('logs only a masked recipient and never the code', async () => {
    const logged: string[] = [];
    const capture = (message: unknown): void => {
      logged.push(String(message));
    };
    vi.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(capture);

    const { handler } = harness();
    await handler.handle(event(), 1);

    const output = logged.join('\n');
    expect(output).toContain('u***@example.com');
    expect(output).not.toContain(EMAIL);
    expect(output).not.toContain(CODE);
  });
});

describe('Nodemailer adapter (BR-03 budget)', () => {
  it('applies the handler timeout to every SMTP phase and closes on destroy', async () => {
    vi.stubEnv('SMTP_HOST', 'mailpit');
    vi.stubEnv('SMTP_PORT', '1025');
    vi.stubEnv('SMTP_FROM', 'no-reply@train.local');
    vi.stubEnv('EVENT_HANDLER_TIMEOUT_MS', '2500');

    const sendMail = vi.fn(async () => ({ accepted: [EMAIL] }));
    const close = vi.fn();
    createTransportMock.mockReturnValue({ sendMail, close });

    const sender = new NodemailerEmailSender();
    sender.onModuleInit();

    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'mailpit',
      port: 1025,
      secure: false,
      connectionTimeout: 2500,
      greetingTimeout: 2500,
      socketTimeout: 2500,
    });

    await sender.send({
      to: EMAIL,
      subject: 'subject',
      text: 'body',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@train.local',
      to: EMAIL,
      subject: 'subject',
      text: 'body',
    });

    sender.onModuleDestroy();
    expect(close).toHaveBeenCalledOnce();
  });
});
