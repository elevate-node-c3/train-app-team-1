import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The shape *inside* a service. `test/unit/architecture-boundaries.spec.ts`
 * guards the boundary *between* services.
 *
 * A feature is `modules/<feature>/` with concrete `*.controller.ts`,
 * `*.service.ts`, `*.repository.ts` files and a `<feature>.module.ts` at its
 * root.
 */

const APPS_DIR = join(process.cwd(), 'apps');

/** Folders allowed only when they hold more than one non-spec file. */
const OPTIONAL_GROUP_DIRECTORIES = [
  'controllers',
  'services',
  'repositories',
  'listeners',
  'consumers',
] as const;

function tsFilesIn(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found = found.concat(tsFilesIn(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      // Specs live beside their subject. A test is not part of a feature: it
      // reaches across all of them on purpose, and imports vitest and whatever
      // the file under test does.
      !entry.endsWith('.spec.ts')
    ) {
      found.push(full);
    }
  }
  return found;
}

function appOf(file: string): string {
  return relative(APPS_DIR, file).split(sep)[0];
}

function srcDirOf(app: string): string {
  return join(APPS_DIR, app, 'src');
}

function modulesDirOf(app: string): string {
  return join(srcDirOf(app), 'modules');
}

function appNames(): string[] {
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Derived from the tree, not listed by hand: a service grows feature modules
 * when it gets its first feature, and these rules should start applying to it
 * the moment it does rather than when somebody remembers to add it here.
 */
function featureModuleApps(): string[] {
  return appNames().filter((app) => existsSync(modulesDirOf(app)));
}

function moduleFilesOf(app: string): string[] {
  const modulesDir = modulesDirOf(app);
  return existsSync(modulesDir) ? tsFilesIn(modulesDir) : [];
}

function allAppFiles(): string[] {
  return appNames().flatMap((app) => {
    const srcDir = srcDirOf(app);
    return existsSync(srcDir) ? tsFilesIn(srcDir) : [];
  });
}

function directoriesIn(root: string): string[] {
  const directories: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    directories.push(full, ...directoriesIn(full));
  }
  return directories;
}

/**
 * Block comments and whole-line `//` comments removed. Anchored deliberately:
 * stripping every `//` would also eat the one inside a `postgres://` literal.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `from '...'` specifier in a file, import or re-export. */
function importsOf(content: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm;
  for (const match of content.matchAll(pattern)) {
    specifiers.push(match[1]);
  }
  // `import 'side-effect.js'` has no `from`.
  for (const match of content.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

interface ImportStatement {
  specifier: string;
  typeOnly: boolean;
}

/**
 * Import statements with enough shape to distinguish `import type` (and an
 * all-`type` named list) from a runtime dependency. Entity imports are allowed
 * to carry sibling types, because a row's string unions have to live somewhere.
 */
function importStatementsOf(content: string): ImportStatement[] {
  const statements: ImportStatement[] = [];
  const pattern = /^\s*import\s+(?!['"])([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;

  for (const match of content.matchAll(pattern)) {
    const clause = match[1].trim();
    statements.push({
      specifier: match[2],
      typeOnly:
        clause.startsWith('type ') ||
        /^\{\s*(?:type\s+[^,}]+\s*,?\s*)+\}$/.test(clause),
    });
  }

  for (const match of content.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    statements.push({ specifier: match[1], typeOnly: false });
  }

  return statements;
}

function isTypeOrmSpecifier(specifier: string): boolean {
  return (
    specifier === 'typeorm' ||
    specifier.startsWith('typeorm/') ||
    specifier.startsWith('@nestjs/typeorm')
  );
}

function importsRepository(specifier: string): boolean {
  return (
    specifier.includes('/repositories/') ||
    specifier.startsWith('./repositories') ||
    specifier.startsWith('../repositories')
  );
}

function moduleRelativeParts(app: string, file: string): string[] {
  return relative(modulesDirOf(app), file).split(sep);
}

const featureFiles = featureModuleApps().flatMap(moduleFilesOf);

describe('Feature module boundaries (§2.5)', () => {
  it('finds feature modules to check', () => {
    // A rename of `modules/` would make every assertion below vacuously pass.
    expect(featureFiles.length).toBeGreaterThan(0);
  });

  it('finds app source files to check', () => {
    expect(allAppFiles().length).toBeGreaterThan(0);
  });

  it('keeps controllers away from repositories and TypeORM', () => {
    const violations: string[] = [];

    for (const file of allAppFiles()) {
      if (!file.endsWith('.controller.ts')) continue;
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        if (isTypeOrmSpecifier(specifier)) {
          violations.push(`${file} imports '${specifier}'`);
        }
        if (importsRepository(specifier)) {
          violations.push(
            `${file} imports '${specifier}' — go through the feature service`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('uses an allowed transport suffix for every @Controller file', () => {
    const violations: string[] = [];
    const controllerSuffixes = [
      '.controller.ts',
      '.grpc.controller.ts',
      '.microservice.controller.ts',
    ] as const;

    for (const file of allAppFiles()) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      if (!/@Controller\s*\(/.test(source)) continue;

      if (!controllerSuffixes.some((suffix) => file.endsWith(suffix))) {
        violations.push(
          `${file} is @Controller-decorated but uses no allowed controller suffix`,
        );
      }
      if (
        file.endsWith('.consumer.ts') ||
        file.endsWith('.event.listener.ts')
      ) {
        violations.push(
          `${file} is @Controller-decorated but is named as a consumer/listener`,
        );
      }
      if (
        /@GrpcMethod\s*\(/.test(source) &&
        !file.endsWith('.grpc.controller.ts')
      ) {
        violations.push(
          `${file} declares a gRPC method but is not a *.grpc.controller.ts`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps TypeORM entities as pure rows', () => {
    const violations: string[] = [];

    for (const file of allAppFiles()) {
      if (!file.endsWith('.entity.ts')) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));

      for (const { specifier, typeOnly } of importStatementsOf(source)) {
        if (specifier.startsWith('@nestjs/')) {
          violations.push(
            `${file} imports '${specifier}' — entities must not import Nest`,
          );
          continue;
        }

        if (specifier.startsWith('.')) {
          // A relation needs its target class at runtime: TypeORM's
          // `@ManyToOne(() => OtherEntity)` evaluates that arrow when the
          // metadata is built, so the import cannot be type-only. Entity to
          // entity is therefore allowed; anything else relative must stay
          // type-only, which is what keeps a row object from reaching into a
          // service, a repository or a module.
          //
          // The cycle this permits is caught separately, below.
          const entityToEntity = /\.entity(\.js|\.ts)?$/.test(specifier);

          if (!typeOnly && !entityToEntity) {
            violations.push(
              `${file} has a runtime import from '${specifier}' — only another *.entity module may be imported at runtime`,
            );
          }
          continue;
        }

        if (specifier === '@app/contracts') continue;
        if (isTypeOrmSpecifier(specifier)) continue;
        violations.push(
          `${file} imports '${specifier}' — entities may import only typeorm and @app/contracts`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * Entities may reference each other at runtime, but the graph they form
   * must stay acyclic.
   *
   * Two entity modules that import each other are a genuine ESM cycle: one
   * of them is evaluated while the other is still a half-initialised module
   * record, so a decorator that touches the other class gets `undefined`.
   * TypeORM's lazy `() => Entity` arrow usually defers past the hazard, but
   * it depends on load order and fails without a useful message when it does
   * fail.
   *
   * The fix is never to drop the relation: an inverse side takes its target
   * as a string -- `@OneToMany('StationEntity', 'city')` -- and imports the
   * class with `import type`. The relation still works in both directions
   * and the back-edge disappears.
   */
  it('keeps the entity runtime-import graph acyclic', () => {
    const edges = new Map<string, string[]>();

    for (const file of allAppFiles()) {
      if (!file.endsWith('.entity.ts')) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      const targets: string[] = [];

      for (const { specifier, typeOnly } of importStatementsOf(source)) {
        if (typeOnly || !specifier.startsWith('.')) continue;
        if (!/\.entity(\.js|\.ts)?$/.test(specifier)) continue;

        // '../x/y.entity.js' resolves to the '.ts' that actually exists.
        targets.push(resolve(dirname(file), specifier).replace(/\.js$/, '.ts'));
      }

      edges.set(file, targets);
    }

    const cycles: string[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();

    const walk = (node: string, trail: string[]): void => {
      if (visiting.has(node)) {
        const loop = [...trail.slice(trail.indexOf(node)), node];
        cycles.push(loop.map((entry) => basename(entry)).join(' -> '));
        return;
      }
      if (done.has(node)) return;

      visiting.add(node);
      for (const next of edges.get(node) ?? []) {
        walk(next, [...trail, node]);
      }
      visiting.delete(node);
      done.add(node);
    };

    for (const node of edges.keys()) walk(node, []);

    expect([...new Set(cycles)]).toEqual([]);
  });

  it('keeps single-file groups at the module root', () => {
    const violations: string[] = [];

    for (const app of featureModuleApps()) {
      for (const file of moduleFilesOf(app)) {
        const parts = moduleRelativeParts(app, file);
        if (parts.length < 3) continue; // modules/<feature>/<file>
        const [feature, group] = parts;
        if (
          !(OPTIONAL_GROUP_DIRECTORIES as readonly string[]).includes(group)
        ) {
          continue;
        }
        const groupDir = join(modulesDirOf(app), feature, group);
        const count = tsFilesIn(groupDir).length;
        if (count <= 1) {
          violations.push(
            `${groupDir} holds ${count} non-spec file(s); inline them at the module root`,
          );
        }
      }
    }

    expect([...new Set(violations)]).toEqual([]);
  });

  it('always keeps DTOs and entities in their own folders', () => {
    const violations: string[] = [];

    for (const file of featureFiles) {
      const parent = basename(dirname(file));
      if (file.endsWith('.dto.ts') && parent !== 'dto') {
        violations.push(`${file} must live in a dto/ folder`);
      }
      if (file.endsWith('.entity.ts') && parent !== 'entities') {
        violations.push(`${file} must live in an entities/ folder`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps every feature module at the feature root', () => {
    const violations: string[] = [];

    for (const file of featureFiles) {
      if (!file.endsWith('.module.ts')) continue;
      const app = appOf(file);
      const parts = moduleRelativeParts(app, file);
      // modules/<feature>/<feature>.module.ts
      if (parts.length !== 2) {
        violations.push(
          `${file} must sit directly under its feature's modules/<feature>/ root`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('uses transport-specific controller, consumer and listener suffixes', () => {
    const violations: string[] = [];

    for (const file of featureFiles) {
      const app = appOf(file);
      const parts = moduleRelativeParts(app, file);
      if (parts.length < 3) continue;
      const group = parts[1];
      const name = basename(file);

      if (group === 'controllers' && !name.endsWith('.controller.ts')) {
        violations.push(`${file} must end with '.controller.ts'`);
      }
      if (group === 'consumers' && !name.endsWith('.consumer.ts')) {
        violations.push(`${file} must end with '.consumer.ts'`);
      }
      if (group === 'listeners' && !name.endsWith('.event.listener.ts')) {
        violations.push(`${file} must end with '.event.listener.ts'`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps repositories concrete and free of ports or base classes', () => {
    const violations: string[] = [];

    for (const file of featureFiles) {
      const app = appOf(file);
      const parts = moduleRelativeParts(app, file);
      if (!parts.includes('repositories') && !file.endsWith('.repository.ts')) {
        continue;
      }
      if (!file.endsWith('.repository.ts')) {
        violations.push(`${file} must end with '.repository.ts'`);
        continue;
      }

      const source = withoutComments(readFileSync(file, 'utf8'));
      if (!/\bexport\s+class\b/.test(source)) {
        violations.push(`${file} must export a concrete class`);
      }
      if (/\babstract\s+class\b/.test(source)) {
        violations.push(`${file} must not be abstract`);
      }
      if (/\bexport\s+interface\b/.test(source)) {
        violations.push(`${file} must not declare a repository interface`);
      }
      if (/\bclass\s+\w*Repository\b[\s\S]*?\bextends\b/.test(source)) {
        violations.push(`${file} must not extend a generic base repository`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps process.env in config, main.ts and module files', () => {
    const violations: string[] = [];

    for (const app of appNames()) {
      const srcDir = srcDirOf(app);
      if (!existsSync(srcDir)) continue;
      for (const file of tsFilesIn(srcDir)) {
        const path = relative(srcDir, file);
        const allowed =
          path.startsWith(`config${sep}`) ||
          path === 'main.ts' ||
          path.endsWith('.module.ts');
        if (
          !allowed &&
          /\bprocess\.env\b/.test(withoutComments(readFileSync(file, 'utf8')))
        ) {
          violations.push(
            `${file} reads process.env; move the read into config/`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps every service root module at src/<service>.module.ts', () => {
    // Every app, not only the ones with features: a service whose root module
    // is somewhere else has nowhere obvious to register its first one.
    const missing = appNames().filter(
      (app) => !existsSync(join(srcDirOf(app), `${app}.module.ts`)),
    );

    expect(missing).toEqual([]);
  });
});
