import { Inject, Injectable } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import {
  IDENTITY_SERVICE_NAME,
  type ResolveNotificationRecipientRequest,
  type ResolveNotificationRecipientResponse,
  type SupportedLanguage,
} from '@app/contracts';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import { TravellerProfileRepository } from '../profile-completed/traveller-profile.repository.js';
import { notificationIdentityServiceKey } from '../../config/env.schema.js';

export const NOTIFICATION_IDENTITY_GRPC = 'NOTIFICATION_IDENTITY_GRPC';
const DIRECTORY_TIMEOUT_MS = 1_000;

interface NotificationIdentityClient {
  resolveNotificationRecipient(
    request: ResolveNotificationRecipientRequest,
    metadata: Metadata,
    options: { deadline: number },
  ): Observable<ResolveNotificationRecipientResponse>;
}

@Injectable()
export class NotificationRecipientService {
  constructor(
    private readonly travellers: TravellerProfileRepository,
    @Inject(NOTIFICATION_IDENTITY_GRPC) private readonly identity: ClientGrpc,
    private readonly cls: ClsService,
  ) {}

  async emailFor(accountId: string): Promise<string> {
    const traveller = await this.travellers.findByAccountId(accountId);
    if (traveller?.email) return traveller.email;

    // Historical registrations were already acknowledged before email was stored.
    const { email } = await this.resolve(accountId);
    await this.travellers.upsertEmail(accountId, email);
    return email;
  }

  /**
   * TA-108: the address and the account's own language -- never a request's.
   * Both are normally on file; an account from before the language was
   * recorded asks identity, which answers both, once.
   */
  async recipientFor(
    accountId: string,
  ): Promise<{ email: string; language: SupportedLanguage }> {
    const traveller = await this.travellers.findByAccountId(accountId);
    if (traveller?.email && traveller.language) {
      return { email: traveller.email, language: traveller.language };
    }

    const recipient = await this.resolve(accountId);
    await this.travellers.upsertEmail(accountId, recipient.email);
    await this.travellers.recordLanguage(accountId, recipient.language);
    return recipient;
  }

  private async resolve(
    accountId: string,
  ): Promise<{ email: string; language: SupportedLanguage }> {
    const key = notificationIdentityServiceKey();
    if (!key || key.length < 32) {
      throw new Error('Notification recipient lookup is not configured');
    }
    const metadata = new Metadata();
    metadata.set('x-notification-identity-key', key);
    const correlationId = this.cls.get<string>(CORRELATION_ID_KEY);
    if (correlationId) metadata.set('x-correlation-id', correlationId);
    const client = this.identity.getService<NotificationIdentityClient>(
      IDENTITY_SERVICE_NAME,
    );
    const result = await firstValueFrom(
      client
        .resolveNotificationRecipient({ accountId }, metadata, {
          deadline: Date.now() + DIRECTORY_TIMEOUT_MS,
        })
        .pipe(timeout(DIRECTORY_TIMEOUT_MS)),
    );
    if (
      typeof result.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+$/.test(result.email)
    ) {
      throw new Error('Notification recipient is not available yet');
    }
    // Identity's own default, for an identity that predates the field.
    return {
      email: result.email,
      language: result.language === 'en' ? 'en' : 'ar',
    };
  }
}
