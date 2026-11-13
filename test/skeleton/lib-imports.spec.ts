import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const APPS = [
  'catalog',
  'gateway',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
] as const;
const LIBS = ['contracts', 'messaging', 'common'] as const;

// Build a real app: Vite accepts directory aliases that `nodenext` rejects.
// The temporary source probe is removed after the suite.
const PROBE = 'apps/gateway/src/alias-import-probe.ts';

describe('shared libs are importable from a service build', () => {
  afterAll(() => {
    rmSync(PROBE, { force: true });
  });

  it('builds an app that imports all three aliases, emitting the entry the image runs', () => {
    writeFileSync(
      PROBE,
      [
        "import { CommonModule } from '@app/common';",
        "import { EVENT_TYPES } from '@app/contracts';",
        "import { MessagingModule } from '@app/messaging';",
        '',
        'export const probe = [CommonModule, EVENT_TYPES, MessagingModule];',
        '',
      ].join('\n'),
    );

    execSync('npx nest build gateway', { stdio: 'pipe' });

    // rootDir controls the emitted path; Dockerfile CMD and `start:prod`
    // need this exact entry point.
    expect(existsSync('dist/apps/gateway/src/main.js')).toBe(true);
    expect(existsSync('dist/libs/contracts/src/index.js')).toBe(true);

    // tsc rewrites aliases to relative paths; no imports map or workspace helps
    // at runtime. Import the output to catch ERR_MODULE_NOT_FOUND even when
    // types pass. main.ts imports no libs, so its output cannot cover this.
    execSync(
      'node --input-type=module -e "await import(\'./dist/apps/gateway/src/alias-import-probe.js\')"',
      { stdio: 'pipe' },
    );
  }, 180_000);

  it('runs the compiled entry from the path the Dockerfile uses', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toMatch(/node dist\/apps\/\$APP\/src\/main/);

    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['start:prod']).toBe('node dist/apps/gateway/src/main');
  });

  // Build gateway only to keep the suite fast; check the other configs
  // match its output paths.
  it.each([...APPS])(
    'apps/%s emits from the repo root so libs are in scope',
    (app) => {
      const cfg = JSON.parse(
        readFileSync(`apps/${app}/tsconfig.app.json`, 'utf8'),
      );
      expect(cfg.compilerOptions.rootDir).toBe('../..');
      expect(cfg.compilerOptions.outDir).toBe('../../dist');
    },
  );

  it.each([...LIBS])('libs/%s emits from the repo root too', (lib) => {
    const cfg = JSON.parse(
      readFileSync(`libs/${lib}/tsconfig.lib.json`, 'utf8'),
    );
    expect(cfg.compilerOptions.rootDir).toBe('../..');
    expect(cfg.compilerOptions.outDir).toBe('../../dist');
  });
});
