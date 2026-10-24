import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  ACCOUNTS_SERVICE_NAME,
  getAccountsProtoPath,
  type SignUpRequestDto,
  type SignUpResponseDto,
} from '@app/contracts';
import { createGrpcMetadataWithCorrelation } from '@app/common';
import type { AccountsClientPort } from '../../application/ports/accounts.port.js';

/** The HTTP request must not hang longer than this on identity. */
export const ACCOUNTS_CALL_TIMEOUT_MS = 2500;

type SignUpCallback = (
  error: grpc.ServiceError | null,
  response?: SignUpResponseDto,
) => void;

interface AccountsServiceClient extends grpc.Client {
  signUp(
    request: { email: string; language: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: SignUpCallback,
  ): grpc.ClientUnaryCall;
}

interface AccountsServiceConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ): AccountsServiceClient;
}

/**
 * Resolves the generated client constructor from accounts.proto.
 *
 * Raw grpc-js rather than Nest's `ClientProxy` because sign-up needs the
 * unary `signUp(request, metadata, options, callback)` shape directly: the
 * correlation id goes into metadata and the 2.5 s budget into the call
 * options, both of which the proxy hides behind RxJS.
 */
function accountsServiceConstructor(): AccountsServiceConstructor {
  const definition = protoLoader.loadSync(getAccountsProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    train: {
      accounts: {
        v1: Record<string, AccountsServiceConstructor>;
      };
    };
  };
  return loaded.train.accounts.v1[ACCOUNTS_SERVICE_NAME];
}

/**
 * Builds the channel in `onModuleInit`, never in the constructor: the skeleton
 * test compiles every module without Docker, and constructing a channel is the
 * kind of I/O that must not happen while Nest is still wiring providers.
 */
@Injectable()
export class IdentityAccountsGrpcAdapter
  implements AccountsClientPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IdentityAccountsGrpcAdapter.name);
  private client: AccountsServiceClient | null = null;

  constructor(private readonly cls: ClsService) {}

  onModuleInit(): void {
    try {
      const Service = accountsServiceConstructor();
      const url = process.env.IDENTITY_GRPC_URL || 'identity:50051';
      this.client = new Service(url, grpc.credentials.createInsecure());
      this.logger.log(`Connected accounts client to ${url}`);
    } catch (error: unknown) {
      // Degrade, don't crash: the readiness probe and the 503 below are the
      // honest signals. A bad URL should not take the whole gateway down.
      this.logger.warn(
        `Failed to initialize identity accounts client: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = null;
  }

  async signUp(input: SignUpRequestDto): Promise<SignUpResponseDto> {
    const client = this.client;
    if (!client) {
      throw new ServiceUnavailableException('identity is unavailable');
    }

    const metadata = createGrpcMetadataWithCorrelation(this.cls);
    const deadline = Date.now() + ACCOUNTS_CALL_TIMEOUT_MS;

    return new Promise<SignUpResponseDto>((resolve, reject) => {
      client.signUp(
        { email: input.email, language: input.language ?? '' },
        metadata,
        { deadline },
        (error, response) => {
          if (!error) {
            resolve(
              response ?? {
                accountId: '',
                email: input.email,
                language: input.language ?? 'ar',
              },
            );
            return;
          }

          if (
            error.code === grpc.status.UNAVAILABLE ||
            error.code === grpc.status.DEADLINE_EXCEEDED
          ) {
            reject(
              new ServiceUnavailableException('identity is unavailable'),
            );
            return;
          }

          this.logger.warn(
            `identity sign-up failed with gRPC status ${error.code}: ${error.message}`,
          );
          reject(new InternalServerErrorException('sign-up failed'));
        },
      );
    });
  }
}
