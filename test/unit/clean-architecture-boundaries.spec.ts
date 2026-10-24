import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';

/**
 * Enforces the dependency rule from ADR-0007:
 *
 *   presentation ─┐
 *                 ├─> application ──> domain
 *   infrastructure┘
 *
 * `test/unit/architecture-boundaries.spec.ts` guards the boundary *between*
 * services; this one guards the layers *inside* a service. Without it, "clean
 * architecture" is a folder naming convention that decays on the first
 * deadline.
 */

const LAYERS = [
  'domain',
  'application',
  'infrastructure',
  'presentation',
] as const;
type Layer = (typeof LAYERS)[number];

function tsFilesIn(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found = found.concat(tsFilesIn(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

function moduleFiles(): string[] {
  const appsDir = join(process.cwd(), 'apps');
  const files: string[] = [];
  for (const app of readdirSync(appsDir)) {
    const modulesDir = join(appsDir, app, 'src', 'modules');
    try {
      if (!statSync(modulesDir).isDirectory()) continue;
    } catch {
      continue; // a service with no feature modules yet
    }
    files.push(...tsFilesIn(modulesDir));
  }
  return files;
}

/** The layer a file belongs to, or null for a feature's own `*.module.ts`. */
function layerOf(file: string): Layer | null {
  const parts = file.split(sep);
  for (const layer of LAYERS) {
    if (parts.includes(layer)) return layer;
  }
  return null;
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

/**
 * The layer a relative import lands in, so `presentation` importing
 * `../../infrastructure/x.js` is caught by where it resolves rather than by
 * how it is spelled.
 */
function resolvedLayer(file: string, specifier: string): Layer | null {
  if (!specifier.startsWith('.')) return null;
  return layerOf(resolve(dirname(file), specifier));
}

const files = moduleFiles();

describe('Clean architecture layer boundaries (ADR-0007, §2.5)', () => {
  it('finds feature modules to check', () => {
    // A rename of `modules/` would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(0);
  });

  // The domain is the one layer with no excuses. It holds entities, value
  // objects and invariants, and it must be unit-testable with no container, no
  // database and no broker. `@app/contracts` is permitted because it is pure
  // shapes by charter — no logic, no DI, no I/O.
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

    for (const file of files) {
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
  // extent of @Injectable()/@Inject() — a named concession in ADR-0007,
  // because manual factory providers for every use-case buy nothing. It must
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

    for (const file of files) {
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

  // `@app/common` re-exports TypeORM-aware modules through its barrel, so a
  // bare import would drag the ORM into the application layer by transitivity.
  // Subpath imports are fine and are how a use-case reaches
  // `persistence/unit-of-work.port.js`, which imports nothing at all.
  it('lets the application layer import @app/common only by subpath', () => {
    const violations: string[] = [];

    for (const file of files) {
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

  // A controller that can reach a repository will eventually reach one, and
  // then the use-case stops being the single entry point to the feature.
  it('stops presentation from reaching into infrastructure', () => {
    const violations: string[] = [];

    for (const file of files) {
      if (layerOf(file) !== 'presentation') continue;
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        if (resolvedLayer(file, specifier) === 'infrastructure') {
          violations.push(
            `${file} imports '${specifier}' — go through a use-case or a port`,
          );
        }
        if (specifier.startsWith('typeorm')) {
          violations.push(`${file} imports '${specifier}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  // Keeps the shape discoverable: everything inside a feature is in a layer,
  // and the only file at the feature root is the module that wires it.
  it('puts every file in a layer, except the feature module itself', () => {
    const misplaced = files.filter(
      (file) => layerOf(file) === null && !file.endsWith('.module.ts'),
    );

    expect(misplaced).toEqual([]);
  });
});
