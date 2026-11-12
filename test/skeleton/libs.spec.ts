import { readFileSync } from 'node:fs';

const LIBS = ['contracts', 'messaging', 'common'] as const;
const nestCli = JSON.parse(readFileSync('nest-cli.json', 'utf8'));
const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'));

describe('shared libs', () => {
  it('registers exactly the three libs as libraries', () => {
    const libs = Object.entries(nestCli.projects)
      .filter(([, p]: [string, any]) => p.type === 'library')
      .map(([name]) => name);
    expect(libs.sort()).toEqual([...LIBS].sort());
  });

  // Without baseUrl, TypeScript 6 requires './' paths (TS5090).
  // `nodenext` needs index.ts targets; Vite also accepts directories.
  // lib-imports.spec.ts checks the real build.
  it.each(LIBS)('declares both tsconfig paths for @app/%s', (lib) => {
    expect(tsconfig.compilerOptions.paths[`@app/${lib}`]).toEqual([
      `./libs/${lib}/src/index.ts`,
    ]);
    expect(tsconfig.compilerOptions.paths[`@app/${lib}/*`]).toEqual([
      `./libs/${lib}/src/*`,
    ]);
  });

  it('resolves each alias to a module export', async () => {
    const [contracts, messaging, common] = await Promise.all([
      import('@app/contracts'),
      import('@app/messaging'),
      import('@app/common'),
    ]);
    // Contracts exports constants, not a Nest module.
    expect(contracts.EVENT_TYPES).toBeDefined();
    expect(messaging.MessagingModule).toBeDefined();
    expect(common.CommonModule).toBeDefined();
  });
});
