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
 * Open SMTP on startup, not in the constructor.
 * Keep SMTP timeouts within the handler limit to avoid overlapping retries.
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
