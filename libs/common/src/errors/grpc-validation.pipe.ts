import { ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import type { RpcException } from '@nestjs/microservices';
import type { ValidationError } from 'class-validator';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

import { validationIssueRefsOf } from '../envelope/validation-exception.factory.js';
import { refusalException } from './to-rpc-exception.js';

/**
 * Field names whose value must never be echoed back. These are not values a
 * traveller typed and could correct -- a trip-scoped HMAC token is issued by
 * identity -- so naming the field is the whole of what a caller can act on.
 *
 * A National ID the caller submitted is deliberately not here: identity echoes
 * it so the traveller can see the digit they got wrong.
 */
const UNECHOABLE_FIELD = /token|password|secret/i;

function withoutSecrets(details: ValidationIssueRef[]): ValidationIssueRef[] {
  return details.map((detail) =>
    UNECHOABLE_FIELD.test(detail.field)
      ? { ...detail, rejectedValue: undefined }
      : detail,
  );
}

/**
 * A malformed gRPC request is a refusal like any other: VALIDATION_ERROR, and
 * one detail per field naming a catalogue key the edge resolves into Arabic or
 * English. The HTTP factory beside this one returns a BadRequestException,
 * which a gRPC handler cannot answer with.
 */
export function grpcValidationExceptionFactory(
  errors: ValidationError[],
): RpcException {
  return refusalException({
    code: ErrorCode.VALIDATION_ERROR,
    details: withoutSecrets(validationIssueRefsOf(errors)),
  });
}

/**
 * The one ValidationPipe configuration a gRPC controller uses.
 *
 * Global pipes do not reach a @GrpcMethod: connectMicroservice is called
 * without inheritAppConfig, so each gRPC controller applies this itself.
 */
export function createGrpcValidationPipe(
  options: ValidationPipeOptions = {},
): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    ...options,
    exceptionFactory: grpcValidationExceptionFactory,
  });
}
