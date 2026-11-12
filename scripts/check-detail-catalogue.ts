import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { DETAIL_CATALOGUE } from '../libs/common/src/envelope/detail-catalogue.js';

export type DetailCatalogue = Readonly<
  Record<string, { readonly ar?: string; readonly en?: string }>
>;

export interface CatalogueSource {
  fileName: string;
  text: string;
}

export interface CatalogueFinding {
  code:
    | 'missing-key'
    | 'blank-language'
    | 'placeholder-mismatch'
    | 'params-mismatch'
    | 'literal-detail';
  message: string;
  key?: string;
  fileName?: string;
  line?: number;
  column?: number;
}

function placeholders(text: string | undefined): string[] {
  // Match the interpolation syntax used by resolveMessageWithParams.
  return [
    ...new Set(
      Array.from((text ?? '').matchAll(/\{\{(\w+)\}\}/g), (m) => m[1]),
    ),
  ].sort();
}

export function auditCatalogue(catalogue: DetailCatalogue): CatalogueFinding[] {
  const findings: CatalogueFinding[] = [];
  for (const [key, entry] of Object.entries(catalogue)) {
    for (const language of ['ar', 'en'] as const) {
      if (typeof entry?.[language] !== 'string' || !entry[language].trim()) {
        findings.push({
          code: 'blank-language',
          key,
          message: `${key}.${language} must be a non-blank string.`,
        });
      }
    }
    if (entry?.ar?.trim() && entry.en?.trim()) {
      const ar = placeholders(entry.ar);
      const en = placeholders(entry.en);
      if (ar.join(',') !== en.join(',')) {
        findings.push({
          code: 'placeholder-mismatch',
          key,
          message: `${key} has different placeholders: ar [${ar.join(', ')}]; en [${en.join(', ')}].`,
        });
      }
    }
  }
  return findings;
}

export function auditSources(
  sources: readonly CatalogueSource[],
  catalogue: DetailCatalogue,
): CatalogueFinding[] {
  const files = new Map(
    sources.map(({ fileName, text }) => {
      const path = posix.resolve('/', fileName.replace(/\\/g, '/'));
      return [
        path,
        ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
      ] as const;
    }),
  );
  const fileNames = new Map(
    sources.map(({ fileName }) => [
      posix.resolve('/', fileName.replace(/\\/g, '/')),
      fileName,
    ]),
  );
  // The in-memory host binds lexical symbols without reading dependencies or
  // running a typecheck. Relative imports can resolve only to supplied sources.
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => files.get(fileName),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName)?.text,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram({
    rootNames: [...files.keys()],
    options: {
      noLib: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    host,
  });
  const checker = program.getTypeChecker();
  const findings: CatalogueFinding[] = [];
  const reported = new Set<string>();

  function unwrap(expression: ts.Expression): ts.Expression {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = expression.expression;
    }
    return expression;
  }

  function constInitializer(
    expression: ts.Identifier,
  ): ts.Expression | undefined {
    const parent = expression.parent;
    let symbol = ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(expression);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      return declaration.initializer;
    }
    return undefined;
  }

  function strings(
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): ts.StringLiteralLike[] | undefined {
    expression = unwrap(expression);
    if (seen.has(expression)) return undefined;
    const visited = new Set(seen).add(expression);
    if (ts.isStringLiteralLike(expression)) return [expression];
    if (ts.isIdentifier(expression)) {
      const initializer = constInitializer(expression);
      return initializer ? strings(initializer, visited) : undefined;
    }
    if (ts.isConditionalExpression(expression)) {
      const yes = strings(expression.whenTrue, visited);
      const no = strings(expression.whenFalse, visited);
      return yes && no ? [...yes, ...no] : undefined;
    }
    return undefined;
  }

  function propertyName(name: ts.PropertyName): string | undefined {
    if (
      ts.isIdentifier(name) ||
      ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name)
    ) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      const names = strings(name.expression);
      if (names?.length === 1) return names[0].text;
    }
    return undefined;
  }

  function object(
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ):
    | { fields: Map<string, ts.Expression | undefined>; complete: boolean }
    | undefined {
    expression = unwrap(expression);
    if (seen.has(expression)) return undefined;
    const visited = new Set(seen).add(expression);
    if (ts.isIdentifier(expression)) {
      const initializer = constInitializer(expression);
      return initializer ? object(initializer, visited) : undefined;
    }
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const fields = new Map<string, ts.Expression | undefined>();
    let complete = true;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = object(property.expression, visited);
        complete &&= spread?.complete ?? false;
        for (const [name, value] of spread?.fields ?? [])
          fields.set(name, value);
      } else {
        const name = propertyName(property.name);
        if (name === undefined) {
          complete = false;
        } else {
          fields.set(
            name,
            ts.isPropertyAssignment(property)
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property)
                ? property.name
                : undefined,
          );
        }
      }
    }
    return { fields, complete };
  }

  function literalText(
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): boolean {
    expression = unwrap(expression);
    if (seen.has(expression)) return false;
    const visited = new Set(seen).add(expression);
    if (ts.isStringLiteralLike(expression)) return true;
    if (ts.isIdentifier(expression)) {
      const initializer = constInitializer(expression);
      return initializer ? literalText(initializer, visited) : false;
    }
    if (ts.isTemplateExpression(expression)) {
      return Boolean(
        expression.head.text.trim() ||
        expression.templateSpans.some(
          (span) =>
            span.literal.text.trim() || literalText(span.expression, visited),
        ),
      );
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        literalText(expression.whenTrue, visited) ||
        literalText(expression.whenFalse, visited)
      );
    }
    if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(expression.operatorToken.kind)
    ) {
      return (
        literalText(expression.left, visited) ||
        literalText(expression.right, visited)
      );
    }
    // Calls and their arguments are not prose: resolved wire values may call
    // includes('{{') or a catalogue resolver without emitting that literal.
    return false;
  }

  for (const source of sources) {
    const file = files.get(
      posix.resolve('/', source.fileName.replace(/\\/g, '/')),
    )!;

    function report(node: ts.Node, finding: CatalogueFinding): void {
      const owner = node.getSourceFile();
      const fileName = fileNames.get(owner.fileName)!;
      const position = node.getStart(owner);
      const identity = `${fileName}:${position}:${finding.code}:${finding.message}`;
      if (reported.has(identity)) return;
      reported.add(identity);
      const location = owner.getLineAndCharacterOfPosition(position);
      findings.push({
        ...finding,
        fileName,
        line: location.line + 1,
        column: location.character + 1,
      });
    }

    function checkKey(key: ts.StringLiteralLike): boolean {
      if (Object.hasOwn(catalogue, key.text)) return true;
      report(key, {
        code: 'missing-key',
        key: key.text,
        message: `${key.text} is absent from DETAIL_CATALOGUE.`,
      });
      return false;
    }

    function checkParams(
      node: ts.Node,
      issues: ts.StringLiteralLike[],
      actions: ts.StringLiteralLike[],
      params: ts.Expression | undefined,
    ): void {
      const supplied = params
        ? object(params)
        : { fields: new Map(), complete: true };
      if (!supplied?.complete) return;
      const actual = [...supplied.fields.keys()].sort();
      for (const issue of issues.length ? issues : [undefined]) {
        for (const action of actions.length ? actions : [undefined]) {
          const keys = [issue, action].filter((key) => key !== undefined);
          if (!keys.every(checkKey)) continue;
          const expected = [
            ...new Set(
              keys.flatMap(({ text }) => [
                ...placeholders(catalogue[text].ar),
                ...placeholders(catalogue[text].en),
              ]),
            ),
          ].sort();
          const missing = expected.filter((name) => !supplied.fields.has(name));
          const extra = actual.filter((name) => !expected.includes(name));
          if (missing.length || extra.length) {
            report(node, {
              code: 'params-mismatch',
              message: `${keys.map(({ text }) => text).join(' + ')} requires params [${expected.join(', ')}], got [${actual.join(', ')}]; missing [${missing.join(', ')}]; extra [${extra.join(', ')}].`,
            });
          }
        }
      }
    }

    function visit(node: ts.Node): void {
      // Type literals/interfaces and comments describe data; they do not emit it.
      if (ts.isTypeNode(node)) return;
      if (ts.isStringLiteralLike(node) && /^(ISSUE|ACTION)_/.test(node.text)) {
        const parent = node.parent;
        if (!(ts.isPropertyAssignment(parent) && parent.name === node))
          checkKey(node);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const resolved = object(node)!;
        const { fields } = resolved;
        if (fields.has('field') || fields.has('rejectedValue')) {
          for (const name of ['issue', 'action', 'message']) {
            const value = fields.get(name);
            if (value && literalText(value)) {
              report(value, {
                code: 'literal-detail',
                message: `Validation detail ${name} contains literal text; emit issueKey/actionKey instead.`,
              });
            }
          }
        }
        const issue = fields.get('issueKey');
        const action = fields.get('actionKey');
        if (resolved.complete && (issue || action)) {
          const issues = issue ? strings(issue) : [];
          const actions = action ? strings(action) : [];
          if (issues && actions)
            checkParams(node, issues, actions, fields.get('params'));
        }
      }
      if (ts.isCallExpression(node)) {
        const keyArguments = node.arguments.flatMap((argument, index) => {
          const values = strings(argument);
          if (
            !values?.length ||
            !values.every((value) => /^(ISSUE|ACTION)_/.test(value.text))
          )
            return [];
          return [{ index, values }];
        });
        if (keyArguments.length) {
          const issues = keyArguments.filter(({ values }) =>
            values.every((value) => value.text.startsWith('ISSUE_')),
          );
          const actions = keyArguments.filter(({ values }) =>
            values.every((value) => value.text.startsWith('ACTION_')),
          );
          const last = keyArguments[keyArguments.length - 1].index;
          const after = node.arguments.slice(last + 1);
          const params =
            after.find((argument) => object(argument)) ??
            (keyArguments[0].index === 0 ? after[1] : after[0]);
          // With a non-resolver positional helper, an unknown key argument
          // between a literal key and params cannot be treated as an absent key.
          const ambiguous =
            keyArguments[0].index > 0 &&
            (!issues.length ||
              (!actions.length &&
                (params ? after.indexOf(params) > 0 : after.length > 0)));
          if (!ambiguous && issues.length <= 1 && actions.length <= 1) {
            checkParams(
              node,
              issues[0]?.values ?? [],
              actions[0]?.values ?? [],
              params,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return findings.sort(
    (a, b) =>
      a.fileName!.localeCompare(b.fileName!) ||
      a.line! - b.line! ||
      a.column! - b.column! ||
      a.message.localeCompare(b.message),
  );
}

const excludedDirectories = new Set([
  'test',
  'tests',
  '__tests__',
  'fixtures',
  '__fixtures__',
  'test-fixtures',
  'node_modules',
  'dist',
]);

export function isProductionSource(fileName: string): boolean {
  const path = fileName.replace(/\\/g, '/');
  return (
    /^(apps|libs)\//.test(path) &&
    path.endsWith('.ts') &&
    !/\.(spec|int-spec|e2e-spec|d|fixtures?)\.ts$/.test(path) &&
    !path.split('/').some((part) => excludedDirectories.has(part))
  );
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export function loadProductionSources(
  root = repositoryRoot,
): CatalogueSource[] {
  const sources: CatalogueSource[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
        visit(path);
      } else if (entry.isFile()) {
        const fileName = relative(root, path).replace(/\\/g, '/');
        if (isProductionSource(fileName)) {
          sources.push({ fileName, text: readFileSync(path, 'utf8') });
        }
      }
    }
  }
  for (const directory of ['apps', 'libs']) visit(join(root, directory));
  return sources.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function main(): void {
  const sources = loadProductionSources();
  const findings = [
    ...auditCatalogue(DETAIL_CATALOGUE),
    ...auditSources(sources, DETAIL_CATALOGUE),
  ];
  if (findings.length) {
    for (const finding of findings) {
      const location = finding.fileName
        ? `${finding.fileName}:${finding.line}:${finding.column}: `
        : '';
      console.error(`${location}[${finding.code}] ${finding.message}`);
    }
    console.error(
      `Detail catalogue check failed: ${findings.length} finding(s).`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Detail catalogue check passed: ${Object.keys(DETAIL_CATALOGUE).length} entries, ${sources.length} production TypeScript files.`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error('Detail catalogue check failed:', error);
    process.exitCode = 1;
  }
}
