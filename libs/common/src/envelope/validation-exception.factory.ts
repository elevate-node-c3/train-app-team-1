import {
  BadRequestException,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { ValidationIssueRef } from '@app/contracts';

import {
  CONSTRAINT_ISSUE_KEYS,
  ISSUE_FALLBACK_KEY,
} from './detail-catalogue.js';

/**
 * BR-57 requires the edge to name the offending field *and* the rejected value,
 * not merely say that "the request is invalid". Nest's default
 * `exceptionFactory` joins constraint strings into an array of sentences, which
 * is why the filter used to guess the field from the first word.
 *
 * Only keys and explicit template params leave this language-agnostic factory.
 * The filter resolves them and supplies a localised action when none is set.
 */
function flatten(
  errors: readonly ValidationError[],
  parent = '',
): ValidationIssueRef[] {
  const details: ValidationIssueRef[] = [];

  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const constraints = Object.keys(error.constraints ?? {});

    if (constraints.length === 0) {
      details.push({
        field,
        rejectedValue: error.value,
        issueKey: ISSUE_FALLBACK_KEY,
      });
    } else {
      for (const name of constraints) {
        const context = error.contexts?.[name] as
          | Partial<
              Pick<ValidationIssueRef, 'issueKey' | 'actionKey' | 'params'>
            >
          | undefined;
        const detail: ValidationIssueRef = {
          field,
          rejectedValue: error.value,
          issueKey:
            typeof context?.issueKey === 'string'
              ? context.issueKey
              : Object.hasOwn(CONSTRAINT_ISSUE_KEYS, name)
                ? CONSTRAINT_ISSUE_KEYS[name]
                : ISSUE_FALLBACK_KEY,
        };
        if (typeof context?.actionKey === 'string') {
          detail.actionKey = context.actionKey;
        }
        if (context?.params !== undefined) {
          detail.params = context.params;
        }
        details.push(detail);
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
