import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const APPS = [
  'catalog', 'gateway', 'identity', 'inventory', 'booking', 'payment', 'notification',
] as const;
const LIBS = ['contracts', 'messaging', 'common'] as const;

// Written into a real app's source tree, built with the real `nest build`, then
// removed. Nothing cheaper is honest here: `libs.spec.ts` proves the aliases
// resolve under Vite, which does directory/index resolution that TypeScript's
// `nodenext` resolution does not — so the suite can be green while
// `nest build` cannot resolve a single alias.
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
        "import { ContractsModule } from '@app/contracts';",
        "import { MessagingModule } from '@app/messaging';",
        '',
        'export const probe = [CommonModule, ContractsModule, MessagingModule];',
        '',
      ].join('\n'),
    );

    execSync('npx nest build gateway', { stdio: 'pipe' });

    // The exact path the Dockerfile's CMD and `start:prod` run. Pinned here
    // because the tsc builder derives it from rootDir, so a change to either
    // silently relocates the entry point and the container exits immediately.
    expect(existsSync('dist/apps/gateway/src/main.js')).toBe(true);
    expect(existsSync('dist/libs/contracts/src/index.js')).toBe(true);
  }, 180_000);

  it('runs the compiled entry from the path the Dockerfile uses', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toMatch(/node dist\/apps\/\$APP\/src\/main/);

    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['start:prod']).toBe('node dist/apps/gateway/src/main');
  });

  // The build test above covers gateway only, because each `nest build` run
  // costs ~10s. These assertions stop the other nine configs from drifting
  // away from the one that is actually exercised.
  it.each([...APPS])('apps/%s emits from the repo root so libs are in scope', (app) => {
    const cfg = JSON.parse(readFileSync(`apps/${app}/tsconfig.app.json`, 'utf8'));
    expect(cfg.compilerOptions.rootDir).toBe('../..');
    expect(cfg.compilerOptions.outDir).toBe('../../dist');
  });

  it.each([...LIBS])('libs/%s emits from the repo root too', (lib) => {
    const cfg = JSON.parse(readFileSync(`libs/${lib}/tsconfig.lib.json`, 'utf8'));
    expect(cfg.compilerOptions.rootDir).toBe('../..');
    expect(cfg.compilerOptions.outDir).toBe('../../dist');
  });
});
