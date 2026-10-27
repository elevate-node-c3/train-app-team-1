import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import {
  smtpSettingsFromEnv,
  type SmtpSettings,
} from '../../config/smtp-settings.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
export class NodemailerEmailSender implements OnModuleInit, OnModuleDestroy {
  private transporter: Transporter | null = null;
  private readonly settings: SmtpSettings = smtpSettingsFromEnv();

  onModuleInit(): void {
    this.transporter = createTransport({
      host: this.settings.host,
      port: this.settings.port,
      secure: false,
      connectionTimeout: this.settings.handlerTimeoutMs,
      greetingTimeout: this.settings.handlerTimeoutMs,
      socketTimeout: this.settings.handlerTimeoutMs,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    if (!this.transporter) {
      throw new Error('SMTP transport has not been initialized');
    }

    await this.transporter.sendMail({
      from: this.settings.from,
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
