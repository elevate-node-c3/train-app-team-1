import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import * as grpc from '@grpc/grpc-js';
import type { SignUpRequestDto, SignUpResponseDto } from '@app/contracts';
import { ErrorCode } from '@app/contracts';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
  HttpExceptionFilter,
  ResponseInterceptor,
} from '@app/common';
import {
  ACCOUNTS_CLIENT,
  type AccountsClientPort,
} from '../../apps/gateway/src/modules/accounts/application/ports/accounts.port.js';
import { SignUpUseCase } from '../../apps/gateway/src/modules/accounts/application/use-cases/sign-up.use-case.js';
import {
  ACCOUNTS_CALL_TIMEOUT_MS,
  IdentityAccountsGrpcAdapter,
} from '../../apps/gateway/src/modules/accounts/infrastructure/grpc/identity-accounts.grpc-adapter.js';
import { AccountsHttpController } from '../../apps/gateway/src/modules/accounts/presentation/http/accounts.http.controller.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const CORRELATION_ID = 'gateway-corr-1';
const RESPONSE: SignUpResponseDto = {
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'user@example.com',
  language: 'ar',
};

function fakeCls(): ClsService {
  return {
    get: (key: string) =>
      key === CORRELATION_ID_KEY ? CORRELATION_ID : undefined,
  } as unknown as ClsService;
}

interface CapturedCall {
  request: { email: string; language: string };
  metadata: grpc.Metadata;
  options: grpc.CallOptions;
}

function serviceError(code: grpc.status, message: string): grpc.ServiceError {
  return Object.assign(new Error(message), {
    code,
    details: message,
    metadata: new grpc.Metadata(),
  }) as grpc.ServiceError;
}

function fakeClient(
  error: grpc.ServiceError | null,
  response?: SignUpResponseDto,
): { client: any; captured: () => CapturedCall } {
  let captured: CapturedCall | undefined;
  const client = {
    close: () => {},
    signUp: (
      callRequest: CapturedCall['request'],
      metadata: grpc.Metadata,
      options: grpc.CallOptions,
      done: (
        callError: grpc.ServiceError | null,
        callResponse?: SignUpResponseDto,
      ) => void,
    ) => {
      captured = { request: callRequest, metadata, options };
      done(error, response);
      return {} as grpc.ClientUnaryCall;
    },
  };
  return { client, captured: () => captured! };
}

describe('Gateway sign-up (ADR-0001, BR-03, BR-56)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the DTO through the use-case unchanged', async () => {
    const signUp = vi.fn(async () => RESPONSE);
    const useCase = new SignUpUseCase({ signUp } as AccountsClientPort);

    const input: SignUpRequestDto = {
      email: 'user@example.com',
      language: 'en',
    };
    await expect(useCase.execute(input)).resolves.toBe(RESPONSE);
    expect(signUp).toHaveBeenCalledWith(input);
  });

  it('calls signUp with correlation metadata and the 2.5s budget', async () => {
    const adapter = new IdentityAccountsGrpcAdapter(fakeCls());
    const fake = fakeClient(null, RESPONSE);
    (adapter as any).client = fake.client;

    await expect(
      adapter.signUp({ email: 'user@example.com', language: 'en' }),
    ).resolves.toEqual(RESPONSE);

    const call = fake.captured();
    expect(call.request).toEqual({
      email: 'user@example.com',
      language: 'en',
    });
    expect(call.metadata.get(CORRELATION_ID_HEADER)).toEqual([CORRELATION_ID]);
    expect(call.options.deadline).toBe(NOW.getTime() + ACCOUNTS_CALL_TIMEOUT_MS);
  });

  it('sends the empty language for downstream Arabic fallback', async () => {
    const adapter = new IdentityAccountsGrpcAdapter(fakeCls());
    const fake = fakeClient(null, RESPONSE);
    (adapter as any).client = fake.client;

    await adapter.signUp({ email: 'user@example.com' });

    expect(fake.captured().request.language).toBe('');
  });

  it('maps UNAVAILABLE and DEADLINE_EXCEEDED to a 503 exception', async () => {
    for (const code of [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]) {
      const adapter = new IdentityAccountsGrpcAdapter(fakeCls());
      const fake = fakeClient(serviceError(code, 'transport down'));
      (adapter as any).client = fake.client;

      await expect(
        adapter.signUp({ email: 'user@example.com' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('does not turn a transport bug into a 503', async () => {
    const adapter = new IdentityAccountsGrpcAdapter(fakeCls());
    const fake = fakeClient(serviceError(grpc.status.INTERNAL, 'boom'));
    (adapter as any).client = fake.client;

    await expect(
      adapter.signUp({ email: 'user@example.com' }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('answers 503 without a channel when the adapter never initialised', async () => {
    const adapter = new IdentityAccountsGrpcAdapter(fakeCls());

    await expect(
      adapter.signUp({ email: 'user@example.com' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect('onModuleInit' in adapter).toBe(true);
    expect('onModuleDestroy' in adapter).toBe(true);
  });
});

describe('Gateway sign-up HTTP contract', () => {
  let app: any;
  let adapter: IdentityAccountsGrpcAdapter;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountsHttpController],
      providers: [
        SignUpUseCase,
        { provide: ACCOUNTS_CLIENT, useClass: IdentityAccountsGrpcAdapter },
        { provide: ClsService, useValue: fakeCls() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor(fakeCls()));
    app.useGlobalFilters(new HttpExceptionFilter(fakeCls()));
    await app.init();

    adapter = moduleRef.get(ACCOUNTS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  it('wraps a successful sign-up in the standard envelope with 201', async () => {
    (adapter as any).client = fakeClient(null, RESPONSE).client;

    const response = await request(app.getHttpServer())
      .post('/identity/sign-up')
      .send({ email: 'user@example.com' })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: RESPONSE,
      error: null,
      correlationId: CORRELATION_ID,
    });
    expect(typeof response.body.timestamp).toBe('string');
  });

  it('answers a malformed email with the standard 400 envelope', async () => {
    const response = await request(app.getHttpServer())
      .post('/identity/sign-up')
      .send({ email: 'not-an-email' })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeNull();
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects an unsupported language at the edge', async () => {
    await request(app.getHttpServer())
      .post('/identity/sign-up')
      .send({ email: 'user@example.com', language: 'fr' })
      .expect(400);
  });

  it('renders a gRPC outage as the standard 503 envelope', async () => {
    (adapter as any).client = fakeClient(
      serviceError(grpc.status.UNAVAILABLE, 'connection refused'),
    ).client;

    const response = await request(app.getHttpServer())
      .post('/identity/sign-up')
      .send({ email: 'user@example.com' })
      .expect(503);

    expect(response.body).toMatchObject({
      success: false,
      data: null,
      error: { code: ErrorCode.SERVICE_UNAVAILABLE },
      correlationId: CORRELATION_ID,
    });
  });
});
