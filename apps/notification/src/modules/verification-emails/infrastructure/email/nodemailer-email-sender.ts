import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { NOTIFICATION_DEFAULTS } from '@app/common/config/env.defaults.js';
import type {
  EmailSenderPort,
  OutboundEmail,
} from '../../application/ports/email-sender.port.js';

function handlerTimeoutMs(): number {
  const raw = Number(process.env.EVENT_HANDLER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : NOTIFICATION_DEFAULTS.handlerTimeoutMs;
}

function smtpPort(): number {
  const raw = Number(process.env.SMTP_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : 1025;
}

/**
 * The SMTP adapter. The transport is built in `onModuleInit`, not in the
 * constructor: `test/skeleton/apps.spec.ts` compiles every root module without
 * Docker, and a constructor that opens a socket would fail that test.
 *
 * All three timeouts share the handler budget. A hung DNS lookup, greeting or
 * socket must fail inside the same 3s the consumer's per-attempt cap allows;
 * otherwise the consumer would abandon a send that is still running, retry it,
 * and produce the duplicate this design already keeps rare.
 */
@Injectable()
export class NodemailerEmailSender
  implements EmailSenderPort, OnModuleInit, OnModuleDestroy
{
  private transporter: Transporter | null = null;
  private readonly from =
    process.env.SMTP_FROM ?? NOTIFICATION_DEFAULTS.smtpFrom;

  onModuleInit(): void {
    const timeout = handlerTimeoutMs();
    this.transporter = createTransport({
      host: process.env.SMTP_HOST ?? 'localhost',
      port: smtpPort(),
      secure: false,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    if (!this.transporter) {
      throw new Error('SMTP transport has not been initialized');
    }

    await this.transporter.sendMail({
      from: this.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    });
  }

  onModuleDestroy(): void {
    this.transporter?.close();
    this.transporter = null;
  }
}
