import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Server,
  ServerCredentials,
  type ServiceDefinition,
  type ServerUnaryCall,
  type sendUnaryData,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpc,
  RpcException,
} from '@nestjs/microservices';
import { getIdentityProtoPath, IDENTITY_PACKAGE_NAME } from '@app/contracts';
import { AuthGrpcController } from '../../apps/identity/src/modules/auth/auth.grpc.controller.js';
import { AccountsService } from '../../apps/identity/src/modules/auth/services/accounts.service.js';
import { AccountRepository } from '../../apps/identity/src/modules/auth/repositories/account.repository.js';
import { NotificationRecipientService } from '../../apps/notification/src/modules/booking-outcomes/notification-recipient.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('notification authoritative recipient transport', () => {
  it('backfills a historical local profile through the credential-protected identity RPC', async () => {
    vi.stubEnv(
      'NOTIFICATION_IDENTITY_SERVICE_KEY',
      'notification-identity-transport-test-key',
    );
    const accountId = '11111111-1111-4111-8111-111111111111';
    const findOne = vi
      .fn()
      .mockResolvedValue({ email: 'historic@example.com', language: 'en' });
    const repository = new AccountRepository({
      getRepository: () => ({ findOne }),
    } as never);
    const accounts = new AccountsService(
      {} as never,
      repository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const controller = new AuthGrpcController(
      accounts,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const definition = loadSync(getIdentityProtoPath(), { defaults: true })[
      `${IDENTITY_PACKAGE_NAME}.IdentityService`
    ] as ServiceDefinition;
    const server = new Server();
    server.addService(definition, {
      resolveNotificationRecipient: (
        call: ServerUnaryCall<{ accountId: string }, { email: string }>,
        done: sendUnaryData<{ email: string }>,
      ) => {
        void controller
          .resolveNotificationRecipient(call.request, call.metadata)
          .then(
            (response) => done(null, response),
            (error: RpcException) => done(error.getError() as ServiceError),
          );
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      );
    });
    const client = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: IDENTITY_PACKAGE_NAME,
        protoPath: getIdentityProtoPath(),
        url: `127.0.0.1:${port}`,
      },
    });
    const profile = {
      email: null as string | null,
      fullName: 'Existing Traveller',
    };
    const travellers = {
      findByAccountId: vi.fn(async () => profile),
      upsertEmail: vi.fn(async (_accountId: string, email: string) => {
        profile.email = email;
      }),
    };
    const recipient = new NotificationRecipientService(
      travellers as never,
      client as unknown as ClientGrpc,
      { get: () => 'transport-correlation' } as never,
    );
    try {
      await expect(recipient.emailFor(accountId)).resolves.toBe(
        'historic@example.com',
      );
      expect(findOne).toHaveBeenCalledExactlyOnceWith({
        where: { id: accountId },
        select: { email: true, language: true },
      });
      expect(travellers.upsertEmail).toHaveBeenCalledExactlyOnceWith(
        accountId,
        'historic@example.com',
      );
      expect(profile.fullName).toBe('Existing Traveller');
      await expect(recipient.emailFor(accountId)).resolves.toBe(
        'historic@example.com',
      );
      expect(findOne).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
      server.forceShutdown();
    }
  });
});
