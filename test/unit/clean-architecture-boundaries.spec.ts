import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The services with feature modules now use the module-first layout: a feature is
 * `modules/<feature>/` with concrete `*.controller.ts`, `*.service.ts`,
 * `*.repository.ts` files and a `<feature>.module.ts` at its root. There are
 * no architectural layer folders and no port/mapper/use-case indirection.
 *
 * The legacy layer scanner below remains as a migration fallback for any app
 * temporarily absent from `MODULE_FIRST_APPS`.
 *
 * `test/unit/architecture-boundaries.spec.ts` guards the boundary *between*
 * services; this one guards the shape *inside* a service.
 */

const APPS_DIR = join(process.cwd(), 'apps');

/** Apps whose `src/modules` tree follows the module-first layout. */
const MODULE_FIRST_APPS = new Set(['gateway', 'identity', 'notification']);

const LAYERS = [
  'domain',
  'application',
  'infrastructure',
  'presentation',
] as const;
type Layer = (typeof LAYERS)[number];

const BANNED_DIRECTORIES = [
  'domain',
  'application',
  'infrastructure',
  'presentation',
  'ports',
  'use-cases',
  'mappers',
] as const;

const BANNED_FILE_SUFFIXES = [
  '.port.ts',
  '.use-case.ts',
  '.mapper.ts',
  '.orm-entity.ts',
  '.dao.ts',
] as const;

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

function moduleFilesOf(app: string): string[] {
  const modulesDir = modulesDirOf(app);
  try {
    if (!statSync(modulesDir).isDirectory()) return [];
  } catch {
    return []; // a service with no feature modules yet
  }
  return tsFilesIn(modulesDir);
}

function moduleFiles(): string[] {
  const files: string[] = [];
  for (const app of readdirSync(APPS_DIR)) {
    files.push(...moduleFilesOf(app));
  }
  return files;
}

function appNames(): string[] {
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
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

/** The layer a file belongs to, or null for a module-first file. */
function layerOf(file: string): Layer | null {
  const parts = file.split(sep);
  for (const layer of LAYERS) {
    if (parts.includes(layer)) return layer;
  }
  return null;
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

/**
 * The layer a relative import lands in, so `presentation` importing
 * `../../infrastructure/x.js` is caught by where it resolves rather than by
 * how it is spelled.
 */
function resolvedLayer(file: string, specifier: string): Layer | null {
  if (!specifier.startsWith('.')) return null;
  return layerOf(resolve(dirname(file), specifier));
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

const files = moduleFiles();
const moduleFirstFiles = files.filter((file) =>
  MODULE_FIRST_APPS.has(appOf(file)),
);
/** Files still governed by the old four-layer rule. */
const layeredFiles = files.filter(
  (file) => !MODULE_FIRST_APPS.has(appOf(file)),
);

describe('Feature module boundaries (§2.5)', () => {
  it('finds feature modules to check', () => {
    // A rename of `modules/` would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(0);
  });

  it('finds app source files to check', () => {
    expect(allAppFiles().length).toBeGreaterThan(0);
  });

  describe('module-first layout', () => {
    it('finds module-first feature files to check', () => {
      // Kept separate: an empty set would silently disable the rules below.
      expect(moduleFirstFiles.length).toBeGreaterThan(0);
    });

    it('bans architectural layer folders and port/mapper/use-case suffixes under every app', () => {
      const violations: string[] = [];

      for (const app of appNames()) {
        const srcDir = srcDirOf(app);
        if (!existsSync(srcDir)) continue;

        for (const directory of directoriesIn(srcDir)) {
          const name = basename(directory);
          if ((BANNED_DIRECTORIES as readonly string[]).includes(name)) {
            violations.push(`${directory} is a banned directory`);
          }
        }

        for (const file of tsFilesIn(srcDir)) {
          const name = basename(file);
          const bannedSuffix = BANNED_FILE_SUFFIXES.find((suffix) =>
            name.endsWith(suffix),
          );
          if (bannedSuffix) {
            violations.push(`${file} uses the banned suffix '${bannedSuffix}'`);
          }
        }
      }

      expect(violations).toEqual([]);
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
            if (!typeOnly) {
              violations.push(
                `${file} has a runtime import from '${specifier}' — use a type-only sibling import`,
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

    it('keeps single-file groups at the module root', () => {
      const violations: string[] = [];

      for (const app of MODULE_FIRST_APPS) {
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

      for (const file of moduleFirstFiles) {
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

      for (const file of moduleFirstFiles) {
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

      for (const file of moduleFirstFiles) {
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

      for (const file of moduleFirstFiles) {
        const app = appOf(file);
        const parts = moduleRelativeParts(app, file);
        if (
          !parts.includes('repositories') &&
          !file.endsWith('.repository.ts')
        ) {
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

    it('keeps each migrated service root module at src/<service>.module.ts', () => {
      const missing = [...MODULE_FIRST_APPS].filter(
        (app) => !existsSync(join(srcDirOf(app), `${app}.module.ts`)),
      );

      expect(missing).toEqual([]);
    });
  });

  // A fallback for an app temporarily left out of MODULE_FIRST_APPS. They are
  // scoped to layered files so a migrated service is not judged against
  // folders it deliberately no longer has.
  describe('legacy layered layout', () => {
    // The domain is the one layer with no excuses. It holds entities, value
    // objects and invariants, and it must be unit-testable with no container,
    // no database and no broker. `@app/contracts` is permitted because it is
    // pure shapes by charter — no logic, no DI, no I/O.
    it('keeps the domain layer free of frameworks and infrastructure', () => {
      const violations: string[] = [];
      const forbidden = [
        '@nestjs/',
        'typeorm',
        'amqplib',
        'nodemailer',
        'ioredis',
        'pg',
        'joi',
        'class-validator',
        'class-transformer',
        'nestjs-pino',
        'nestjs-cls',
        '@app/common',
        '@app/messaging',
      ];

      for (const file of layeredFiles) {
        if (layerOf(file) !== 'domain') continue;
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          if (forbidden.some((f) => specifier.startsWith(f))) {
            violations.push(`${file} imports '${specifier}'`);
          }
          const target = resolvedLayer(file, specifier);
          if (target && target !== 'domain') {
            violations.push(`${file} reaches outward into '${target}'`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    // The application layer orchestrates. It may know Nest exists only to the
    // extent of @Injectable()/@Inject() — a deliberate concession, because
    // manual factory providers for every use-case buy nothing. It must
    // not know *how* anything is stored or sent: that is what ports are for.
    it('keeps the application layer free of I/O technology', () => {
      const violations: string[] = [];
      const forbidden = [
        'typeorm',
        '@nestjs/typeorm',
        '@nestjs/microservices',
        '@nestjs/platform',
        'amqplib',
        'nodemailer',
        'ioredis',
        'pg',
      ];

      for (const file of layeredFiles) {
        if (layerOf(file) !== 'application') continue;
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          if (forbidden.some((f) => specifier.startsWith(f))) {
            violations.push(`${file} imports '${specifier}'`);
          }
          if (
            specifier.startsWith('@nestjs/') &&
            specifier !== '@nestjs/common'
          ) {
            violations.push(
              `${file} imports '${specifier}' (only @nestjs/common is allowed here)`,
            );
          }
          const target = resolvedLayer(file, specifier);
          if (target === 'infrastructure' || target === 'presentation') {
            violations.push(`${file} reaches outward into '${target}'`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    // Environment access belongs to the composition root. An application
    // service that reads it re-parses configuration on every call and makes a
    // unit test depend on the developer's shell.
    it('keeps process.env out of the application and domain layers', () => {
      const violations: string[] = [];

      for (const file of layeredFiles) {
        const layer = layerOf(file);
        if (layer !== 'application' && layer !== 'domain') continue;
        if (
          /\bprocess\.env\b/.test(withoutComments(readFileSync(file, 'utf8')))
        ) {
          violations.push(
            `${file} reads process.env; inject a settings object`,
          );
        }
      }

      expect(violations).toEqual([]);
    });

    // A handler is application policy wherever it lives. `.infrastructure` is
    // a legal layer for consumers, so the layer scanner cannot catch a use-case
    // placed there by name alone.
    it('keeps *.use-case.ts files out of infrastructure', () => {
      const violations = layeredFiles.filter(
        (file) =>
          file.endsWith('.use-case.ts') && layerOf(file) === 'infrastructure',
      );

      expect(violations).toEqual([]);
    });

    // `@app/common` re-exports TypeORM-aware modules through its barrel, so a
    // bare import would drag the ORM into the application layer by
    // transitivity. Subpath imports are fine.
    it('lets the application layer import @app/common only by subpath', () => {
      const violations: string[] = [];

      for (const file of layeredFiles) {
        if (layerOf(file) !== 'application') continue;
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          if (specifier === '@app/common') {
            violations.push(
              `${file} imports the '@app/common' barrel; use a subpath such as '@app/common/persistence/unit-of-work.port.js'`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });

    // `@app/messaging` re-exports the Nest modules that own AMQP connections
    // and TypeORM-backed stores, so a bare import would drag broker and
    // database wiring into the application layer by transitivity.
    it('lets the application layer import @app/messaging only by subpath', () => {
      const violations: string[] = [];

      for (const file of layeredFiles) {
        if (layerOf(file) !== 'application') continue;
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          if (specifier === '@app/messaging') {
            violations.push(
              `${file} imports the '@app/messaging' barrel; use a subpath such as '@app/messaging/consumer/event-handler.port.js'`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });

    // A controller that can reach a repository will eventually reach one, and
    // then the use-case stops being the single entry point to the feature.
    it('stops presentation from reaching into infrastructure', () => {
      const violations: string[] = [];

      for (const file of layeredFiles) {
        if (layerOf(file) !== 'presentation') continue;
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
          if (resolvedLayer(file, specifier) === 'infrastructure') {
            violations.push(
              `${file} imports '${specifier}' — go through a use-case or a port`,
            );
          }
          if (isTypeOrmSpecifier(specifier)) {
            violations.push(`${file} imports '${specifier}'`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    // Keeps the shape discoverable: everything inside a feature is in a layer,
    // and the only file at the feature root is the module that wires it.
    it('puts every file in a layer, except the feature module itself', () => {
      const misplaced = layeredFiles.filter(
        (file) => layerOf(file) === null && !file.endsWith('.module.ts'),
      );

      expect(misplaced).toEqual([]);
    });
  });
});
