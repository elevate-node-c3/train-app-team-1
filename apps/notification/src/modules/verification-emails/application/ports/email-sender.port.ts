export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * The SMTP crossing. Its only job is to hand a rendered message to the mail
 * server and resolve once that server accepted it — the accepted instant is
 * what BR-03 measures, so this method must not resolve before the SMTP 250.
 */
export interface EmailSenderPort {
  send(email: OutboundEmail): Promise<void>;
}
