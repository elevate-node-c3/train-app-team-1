import { describe, expect, it } from 'vitest';

import {
  auditCatalogue,
  auditSources,
  isProductionSource,
  loadProductionSources,
  type DetailCatalogue,
} from '../../../../scripts/check-detail-catalogue.js';
import { DETAIL_CATALOGUE, resolveDetailText } from './detail-catalogue.js';

describe('resolveDetailText', () => {
  it('returns the entry in the requested language', () => {
    expect(resolveDetailText('ACTION_DEFAULT', 'en')).toBe(
      "Send a value that meets this field's constraints.",
    );
    expect(resolveDetailText('ACTION_DEFAULT', 'ar')).toBe(
      'أرسل قيمة تطابق شروط هذا الحقل.',
    );
  });

  it('fills placeholders from params in both languages', () => {
    for (const lang of ['ar', 'en'] as const) {
      const text = resolveDetailText(
        'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
        lang,
        { departureDate: '2026-12-01' },
      );
      expect(text).toContain('2026-12-01');
      expect(text).not.toContain('{{');
    }
  });

  it('leaves a placeholder intact when its param is missing', () => {
    const text = resolveDetailText('ACTION_PICK_RETURN_DATE_ON_OR_AFTER', 'en');
    expect(text).toContain('{{departureDate}}');
    expect(text).not.toContain('undefined');
  });

  it.each(['ISSUE_NO_SUCH_KEY', 'toString', '__proto__'])(
    'falls back to the generic entry for an unknown key %s',
    (key) => {
      for (const lang of ['ar', 'en'] as const) {
        expect(resolveDetailText(key, lang)).toBe(
          DETAIL_CATALOGUE.ISSUE_VALIDATION_FAILED[lang],
        );
      }
    },
  );
});

describe('DETAIL_CATALOGUE', () => {
  it('has non-empty ar and en for every entry', () => {
    for (const [key, entry] of Object.entries(DETAIL_CATALOGUE)) {
      expect(entry.ar.trim(), `${key}.ar`).not.toBe('');
      expect(entry.en.trim(), `${key}.en`).not.toBe('');
      expect(entry.ar, `${key}.ar`).not.toBe(entry.en);
    }
  });

  it('uses direct, standalone sentences in both languages', () => {
    for (const [key, entry] of Object.entries(DETAIL_CATALOGUE)) {
      expect(entry.ar, `${key}.ar`).not.toMatch(/يرجى|عفوا/);
      expect(entry.en, `${key}.en`).not.toMatch(/\bplease\b/i);
      expect(entry.ar, `${key}.ar`).toMatch(/[.!?]$/);
      expect(entry.en, `${key}.en`).toMatch(/[.!?]$/);
    }
  });

  it('names no payment vendor', () => {
    for (const [key, entry] of Object.entries(DETAIL_CATALOGUE)) {
      expect(`${entry.ar} ${entry.en}`.toLowerCase(), key).not.toContain(
        'stripe',
      );
    }
  });
});

describe('detail catalogue source guard', () => {
  const catalogue: DetailCatalogue = {
    ISSUE_EMPTY: { ar: 'Invalid.', en: 'Invalid.' },
    ACTION_DEFAULT: { ar: 'Correct it.', en: 'Correct it.' },
    ISSUE_TRIP: { ar: 'Trip {{tripId}}.', en: 'Trip {{tripId}}.' },
    ACTION_LATER: {
      ar: 'Retry trip {{tripId}} on {{laterDate}}.',
      en: 'Retry trip {{tripId}} on {{laterDate}}.',
    },
    ISSUE_USAGE: {
      ar: '{{tripId}} {{serviceDate}} {{soldCount}} {{heldCount}}.',
      en: '{{tripId}} {{serviceDate}} {{soldCount}} {{heldCount}}.',
    },
    ISSUE_STOPS: {
      ar: '{{tripId}} {{serviceDate}} {{soldCount}} {{heldCount}} {{stationIds}}.',
      en: '{{tripId}} {{serviceDate}} {{soldCount}} {{heldCount}} {{stationIds}}.',
    },
  };

  const audit = (text: string, entries: DetailCatalogue = catalogue) =>
    auditSources([{ fileName: 'apps/example.ts', text }], entries);

  it('rejects an issue or action absent from an intentionally incomplete catalogue', () => {
    const findings = audit(
      `const details = [{
        field: 'trip', rejectedValue: value,
        issueKey: 'ISSUE_EMPTY', actionKey: 'ACTION_DEFAULT',
      }];`,
      {},
    );
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'missing-key',
        key: 'ISSUE_EMPTY',
        fileName: 'apps/example.ts',
        line: 3,
      }),
      expect.objectContaining({ code: 'missing-key', key: 'ACTION_DEFAULT' }),
    ]);
  });

  it.each(['ar', 'en'] as const)(
    'rejects missing and blank %s catalogue text',
    (language) => {
      for (const text of [undefined, '', ' \t\n']) {
        expect(
          auditCatalogue({
            ISSUE_EMPTY: { ar: 'Invalid.', en: 'Invalid.', [language]: text },
          }),
        ).toEqual([
          expect.objectContaining({
            code: 'blank-language',
            key: 'ISSUE_EMPTY',
            message: expect.stringContaining(language),
          }),
        ]);
      }
    },
  );

  it('rejects different language placeholder sets', () => {
    expect(
      auditCatalogue({
        ISSUE_TRIP: { ar: '{{tripId}}.', en: '{{otherTripId}}.' },
      }),
    ).toEqual([
      expect.objectContaining({
        code: 'placeholder-mismatch',
        key: 'ISSUE_TRIP',
        message: expect.stringContaining('otherTripId'),
      }),
    ]);
  });

  it('compares placeholder sets rather than order or repetition', () => {
    expect(
      auditCatalogue({
        ISSUE_TRIP: {
          ar: '{{tripId}} {{laterDate}} {{tripId}}.',
          en: '{{laterDate}} {{tripId}}.',
        },
      }),
    ).toEqual([]);
  });

  it('accepts exactly the union of issue and action placeholders', () => {
    expect(
      audit(`const detail = {
        field: 'trip', rejectedValue: value,
        issueKey: 'ISSUE_TRIP', actionKey: 'ACTION_LATER',
        params: { tripId, laterDate },
      };`),
    ).toEqual([]);
  });

  it.each([
    ['', 'tripId'],
    ['params: {},', 'tripId'],
    ['params: { tripId },', 'laterDate'],
  ])('rejects absent or incomplete params (%s)', (params, missing) => {
    expect(
      audit(`const detail = {
        field: 'trip', rejectedValue: value,
        issueKey: 'ISSUE_TRIP', actionKey: 'ACTION_LATER', ${params}
      };`),
    ).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining(missing),
      }),
    ]);
  });

  it.each([
    ["'ISSUE_TRIP'", "'ACTION_LATER'", '{ tripId, laterDate, typo }'],
    ["'ISSUE_EMPTY'", "'ACTION_DEFAULT'", '{ typo }'],
  ])('rejects extra params for %s', (issueKey, actionKey, params) => {
    expect(
      audit(`const detail = {
        field: 'trip', rejectedValue: value,
        issueKey: ${issueKey}, actionKey: ${actionKey}, params: ${params},
      };`),
    ).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining('extra [typo]'),
      }),
    ]);
  });

  it('resolves lexical const aliases, loop-local shorthand params and spreads', () => {
    expect(
      audit(`const params = { unrelated: 'outer scope' };
        for (const trip of trips) {
          const base = {
            tripId: trip.id, serviceDate: trip.date,
            soldCount: String(trip.soldCount), heldCount: String(trip.heldCount),
            laterDate,
          };
          const params = base;
          details.push({
            field: 'runningDays', rejectedValue: value,
            issueKey: 'ISSUE_USAGE', actionKey: 'ACTION_LATER', params,
          });
          details.push({
            field: 'stops', rejectedValue: value,
            issueKey: 'ISSUE_STOPS', actionKey: 'ACTION_LATER',
            params: { ...params, stationIds: stillInUse.join(', ') },
          });
        }`),
    ).toEqual([]);
  });

  it('still rejects extra or missing keys through a const spread', () => {
    const findings = audit(`const base = { tripId };
      const params = { ...base, typo: 'extra' } as const;
      const detail = {
        field: 'trip', rejectedValue: value,
        issueKey: 'ISSUE_TRIP', actionKey: 'ACTION_LATER', params,
      };`);
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining('missing [laterDate]; extra [typo]'),
      }),
    ]);
  });

  it('checks all literal alternatives of nested conditional keys', () => {
    expect(
      audit(`const issueKey = past ? 'ISSUE_EMPTY'
        : future ? 'ISSUE_TRIP' : 'ISSUE_MISSING';
        const detail = {
          field: 'trip', rejectedValue: value, issueKey,
          actionKey: 'ACTION_DEFAULT',
        };`),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-key', key: 'ISSUE_MISSING' }),
        expect.objectContaining({
          code: 'params-mismatch',
          message: expect.stringContaining('missing [tripId]'),
        }),
      ]),
    );
  });

  it('requires an exact param set for each conditional alternative', () => {
    expect(
      audit(`const detail = {
        field: 'trip', rejectedValue: value,
        issueKey: past ? 'ISSUE_EMPTY' : 'ISSUE_TRIP',
        actionKey: 'ACTION_DEFAULT', params: { tripId },
      };`),
    ).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining('extra [tripId]'),
      }),
    ]);
  });

  it('checks nested DTO contexts with optional action keys', () => {
    expect(
      audit(`class SearchDto {
        @Validate(DifferentStations, {
          context: { issueKey: 'ISSUE_TRIP', params: { tripId } },
        })
        from!: string;
        @Matches(/.*/, {
          context: {
            issueKey: 'ISSUE_TRIP', actionKey: 'ACTION_LATER',
            params: { tripId },
          },
        })
        to!: string;
      }`),
    ).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining('missing [laterDate]'),
      }),
    ]);
  });

  it('checks references in a typed constraint map and default key constants', () => {
    expect(
      audit(`export const CONSTRAINT_ISSUE_KEYS: Record<string, string> = {
        isUuid: 'ISSUE_MISSING_CONSTRAINT',
      };
      export const ACTION_DEFAULT_KEY = 'ACTION_MISSING_DEFAULT';`),
    ).toEqual([
      expect.objectContaining({
        code: 'missing-key',
        key: 'ISSUE_MISSING_CONSTRAINT',
      }),
      expect.objectContaining({
        code: 'missing-key',
        key: 'ACTION_MISSING_DEFAULT',
      }),
    ]);
  });

  it('derives literal keys and lexical params from helper-call arguments', () => {
    const findings = audit(`const params = { tripId, laterDate };
        detail('trip', { rejected: value }, 'ISSUE_TRIP', 'ACTION_LATER', params);
        detail('trip', value, 'ISSUE_TRIP', 'ACTION_LATER', {
          tripId, laterDate, typo,
        });
        detail('trip', value, 'ISSUE_TRIP', 'ACTION_LATER');
        detail('trip', value, 'ISSUE_HELPER_MISSING', 'ACTION_DEFAULT');`);
    expect(findings).toHaveLength(3);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'params-mismatch',
          message: expect.stringContaining('extra [typo]'),
        }),
        expect.objectContaining({
          code: 'params-mismatch',
          message: expect.stringContaining('missing [laterDate, tripId]'),
        }),
        expect.objectContaining({
          code: 'missing-key',
          key: 'ISSUE_HELPER_MISSING',
        }),
      ]),
    );
  });

  it('checks a resolver-style helper with one literal key', () => {
    expect(
      audit(`resolveDetailText('ISSUE_TRIP', lang, { tripId });
        resolveDetailText('ACTION_LATER', lang, { tripId });`),
    ).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining('missing [laterDate]'),
      }),
    ]);
  });

  it('checks a helper that omits the optional action key', () => {
    expect(
      audit(`detail('trip', value, 'ISSUE_TRIP', { tripId });
        detail('trip', value, 'ISSUE_TRIP', {});`),
    ).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        message: expect.stringContaining('missing [tripId]'),
      }),
    ]);
  });

  it('does not assume a partially dynamic helper key is absent', () => {
    expect(
      audit(`detail('trip', value, runtimeIssueKey, 'ACTION_DEFAULT', { tripId });
        detail('trip', value, 'ISSUE_TRIP', runtimeActionKey, { tripId, laterDate });`),
    ).toEqual([]);
  });

  it('resolves relative imported constants and reports their own source locations', () => {
    const sources = [
      {
        fileName: 'libs/keys.ts',
        text: `export const ISSUE_KEY = 'ISSUE_TRIP';
          export const ACTION_KEY = 'ACTION_LATER';`,
      },
      {
        fileName: 'apps/producer.ts',
        text: `import { ISSUE_KEY, ACTION_KEY } from '../libs/keys.js';
          const detail = {
            field, rejectedValue: value,
            issueKey: ISSUE_KEY, actionKey: ACTION_KEY, params: { tripId },
          };`,
      },
    ];
    expect(auditSources(sources, catalogue)).toEqual([
      expect.objectContaining({
        code: 'params-mismatch',
        fileName: 'apps/producer.ts',
        message: expect.stringContaining('missing [laterDate]'),
      }),
    ]);
    expect(auditSources(sources, {})).toEqual([
      expect.objectContaining({
        code: 'missing-key',
        key: 'ISSUE_TRIP',
        fileName: 'libs/keys.ts',
        line: 1,
      }),
      expect.objectContaining({
        code: 'missing-key',
        key: 'ACTION_LATER',
        fileName: 'libs/keys.ts',
        line: 2,
      }),
    ]);
  });

  it.each(['issue', 'action', 'message'])(
    'rejects literal detail %s text, including Arabic and raw templates',
    (property) => {
      for (const value of [
        "'Invalid value.'",
        "'هذه القيمة غير صالحة.'",
        '`Invalid value.`',
        '`Trip ${tripId} is invalid.`',
        "`${'Invalid value.'}`",
        "'Invalid trip ' + tripId",
        "resolvedIssue || 'Invalid value.'",
        "resolvedIssue ?? 'هذه القيمة غير صالحة.'",
        "english ? 'Invalid value.' : 'هذه القيمة غير صالحة.'",
      ]) {
        expect(
          audit(`const detail = {
            field: 'trip', rejectedValue: value, ${property}: ${value},
          };`),
        ).toEqual([
          expect.objectContaining({
            code: 'literal-detail',
            message: expect.stringContaining(property),
          }),
        ]);
      }
    },
  );

  it('rejects const prose aliases and partial detail shapes', () => {
    expect(
      audit(`const issue = 'Invalid value.';
        const first = { field: 'trip', issue };
        const second = { rejectedValue: value, message: 'Invalid value.' };`),
    ).toEqual([
      expect.objectContaining({ code: 'literal-detail' }),
      expect.objectContaining({ code: 'literal-detail' }),
    ]);
  });

  it('accepts audit actions, comments, types and resolved wire serialization', () => {
    expect(
      audit(`audit.append({ action: 'fare.changed', actorAccountId, before, after });
        // { field: 'trip', issueKey: 'ISSUE_COMMENT_MISSING', issue: 'Legacy' }
        type Wire = { field: string; issue: 'ISSUE_TYPE_MISSING' };
        interface Ref { issueKey: 'ISSUE_INTERFACE_MISSING'; params: { tripId: string } }
        const issue = resolveDetailText(ref.issueKey, lang, ref.params);
        const action = resolveDetailText(ref.actionKey, lang, ref.params);
        const defaultAction = resolveDetailText('ACTION_DEFAULT', lang);
        return {
          field, rejectedValue: ref.rejectedValue,
          issue: issue.includes('{{') ? resolveDetailText(fallbackKey, lang) : issue,
          action: action.includes('{{') ? defaultAction : action,
        };`),
    ).toEqual([]);
  });

  it('does not invent dynamic keys, resolver defaults or shadowed runtime params', () => {
    expect(
      audit(`const params = { typo: 'outer scope' };
        function emit(params: Record<string, string>, issueKey: string) {
          return { field, rejectedValue: value, issueKey, actionKey: 'ACTION_LATER', params };
        }
        function staticKey(params: Record<string, string>) {
          return { field, rejectedValue: value, issueKey: 'ISSUE_TRIP', params };
        }
        function resolve(key: string, params: Record<string, string> = {}) {
          return lookup(key, params);
        }
        const dynamicSpread = {
          field, rejectedValue: value, issueKey: 'ISSUE_TRIP',
          params: { ...runtimeParams, tripId },
        };`),
    ).toEqual([]);
  });

  it('still checks literal key references in partially dynamic expressions', () => {
    expect(
      audit(`const detail = {
        field, rejectedValue: value,
        issueKey: condition ? 'ISSUE_DYNAMIC_MISSING' : runtimeKey,
        params: runtimeParams,
      };`),
    ).toEqual([
      expect.objectContaining({
        code: 'missing-key',
        key: 'ISSUE_DYNAMIC_MISSING',
      }),
    ]);
  });

  it('leaves param value type correctness to TypeScript', () => {
    expect(
      audit(`const detail = {
        field, rejectedValue: value, issueKey: 'ISSUE_TRIP',
        params: { tripId: 123 },
      };`),
    ).toEqual([]);
  });

  it.each([
    'apps/gateway/src/controller.spec.ts',
    'libs/common/src/controller.int-spec.ts',
    'apps/gateway/src/controller.e2e-spec.ts',
    'libs/contracts/src/ref.d.ts',
    'apps/catalog/src/__fixtures__/invalid.ts',
    'libs/common/test/fixtures/invalid.ts',
    'libs/common/src/test-fixtures/invalid.ts',
    'libs/common/src/invalid.fixture.ts',
    'test/producer.ts',
    'scripts/producer.ts',
  ])('excludes non-production source %s', (fileName) => {
    expect(isProductionSource(fileName)).toBe(false);
  });

  it.each([
    'apps/catalog/src/producer.ts',
    'libs/common/src/envelope/http-exception.filter.ts',
    'apps\\gateway\\src\\producer.ts',
  ])('includes production source %s', (fileName) => {
    expect(isProductionSource(fileName)).toBe(true);
  });

  it('audits the real production repository in the existing CI test suite', () => {
    const sources = loadProductionSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(
      sources.some(({ fileName }) =>
        fileName.endsWith('timetable-publish.service.ts'),
      ),
    ).toBe(true);
    expect(
      sources.some(({ fileName }) => fileName.endsWith('detail-catalogue.ts')),
    ).toBe(true);
    expect(sources.every(({ fileName }) => isProductionSource(fileName))).toBe(
      true,
    );
    expect([
      ...auditCatalogue(DETAIL_CATALOGUE),
      ...auditSources(sources, DETAIL_CATALOGUE),
    ]).toEqual([]);
  });
});
