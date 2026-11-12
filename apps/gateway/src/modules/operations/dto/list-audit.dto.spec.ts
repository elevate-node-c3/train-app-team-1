import { createValidationPipe } from '@app/common';
import { describe, expect, it } from 'vitest';

import { ListAuditQueryDto } from './list-audit.dto.js';

describe('audit query details through the real validation pipe', () => {
  it('preserves the integer transform and existing ISO date and time validation', async () => {
    const dto = await createValidationPipe().transform(
      { limit: '25', from: '2026-11-12', to: '2026-11-13T00:00:00Z' },
      { type: 'query', metatype: ListAuditQueryDto },
    );

    expect(dto).toBeInstanceOf(ListAuditQueryDto);
    expect(dto).toMatchObject({
      limit: 25,
      from: '2026-11-12',
      to: '2026-11-13T00:00:00Z',
    });
  });

  it('keeps the whole-number context for limit', async () => {
    await expect(
      createValidationPipe().transform(
        { limit: 'not-a-number' },
        {
          type: 'query',
          metatype: ListAuditQueryDto,
        },
      ),
    ).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining([
          expect.objectContaining({
            field: 'limit',
            rejectedValue: 'not-a-number',
            issueKey: 'ISSUE_MUST_BE_WHOLE_NUMBER',
          }),
        ]),
      },
    });
  });

  it.each(['from', 'to'])(
    'keeps the ISO date/time meaning for %s',
    async (field) => {
      await expect(
        createValidationPipe().transform(
          { [field]: 'tomorrow' },
          {
            type: 'query',
            metatype: ListAuditQueryDto,
          },
        ),
      ).rejects.toMatchObject({
        response: {
          message: [
            {
              field,
              rejectedValue: 'tomorrow',
              issueKey: 'ISSUE_ISO_DATE_TIME_FORMAT',
            },
          ],
        },
      });
    },
  );

  it('keeps the existing maximum limit', async () => {
    await expect(
      createValidationPipe().transform(
        { limit: '201' },
        {
          type: 'query',
          metatype: ListAuditQueryDto,
        },
      ),
    ).rejects.toMatchObject({
      response: {
        message: [
          {
            field: 'limit',
            rejectedValue: 201,
            issueKey: 'ISSUE_ABOVE_MAXIMUM',
          },
        ],
      },
    });
  });
});
