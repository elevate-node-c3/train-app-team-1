import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  ACCOUNTS_SERVICE_NAME,
  type SignUpRequestDto,
  type SignUpResponseDto,
} from '@app/contracts';
import {
  CORRELATION_ID_KEY,
  GrpcCorrelationInterceptor,
} from '@app/common';
import { SignUpUseCase } from '../../application/use-cases/sign-up.use-case.js';

/**
 * A thin gRPC adapter over the use-case. Correlation ids arrive in metadata and
 * are restored into CLS by the interceptor; the controller passes the value
 * explicitly into the command so the event can carry it across the async hop.
 */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class AccountsGrpcController {
  constructor(
    private readonly signUpUseCase: SignUpUseCase,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'SignUp')
  async signUp(request: SignUpRequestDto): Promise<SignUpResponseDto> {
    const correlationId =
      this.cls.get<string>(CORRELATION_ID_KEY) || randomUUID();

    return this.signUpUseCase.execute({
      email: request.email,
      language: request.language,
      correlationId,
    });
  }
}
