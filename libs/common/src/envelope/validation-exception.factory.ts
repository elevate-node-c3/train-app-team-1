import {
  BadRequestException,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { ValidationErrorDetail } from '@app/contracts';

/**
 * BR-57 requires the edge to name the offending field *and* the rejected value,
 * not merely say that "the request is invalid". Nest's default
 * `exceptionFactory` joins constraint strings into an array of sentences, which
 * is why the filter used to guess the field from the first word.
 *
 * The action is deliberately omitted here: the filter knows the request's
 * language, this factory is language-agnostic. The filter supplies a localised
 * default when the detail has none.
 */
function flatten(
  errors: readonly ValidationError[],
  parent = '',
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const constraints = Object.values(error.constraints ?? {});

    if (constraints.length === 0) {
      details.push({
        field,
        rejectedValue: error.value,
        issue: 'Validation failed',
        action: '',
      });
    } else {
      for (const issue of constraints) {
        details.push({
          field,
          rejectedValue: error.value,
          issue,
          action: '',
        });
      }
    }

    if (error.children && error.children.length > 0) {
      details.push(...flatten(error.children, field));
    }
  }

  return details;
}

export function validationExceptionFactory(
  errors: ValidationError[],
): BadRequestException {
  return new BadRequestException({ message: flatten(errors) });
}

/** The one ValidationPipe configuration every HTTP edge uses. */
export function createValidationPipe(
  options: ValidationPipeOptions = {},
): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    ...options,
    exceptionFactory: validationExceptionFactory,
  });
}
