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

  // Values carry a leading './' because TypeScript 6.0's config validation
  // (TS5090) requires `paths` entries to be explicitly relative once `baseUrl`
  // is unset — resolution is still relative to this tsconfig's own directory,
  // just spelled out syntactically.
  it.each(LIBS)('declares both tsconfig paths for @app/%s', (lib) => {
    expect(tsconfig.compilerOptions.paths[`@app/${lib}`]).toEqual([`./libs/${lib}/src`]);
    expect(tsconfig.compilerOptions.paths[`@app/${lib}/*`]).toEqual([`./libs/${lib}/src/*`]);
  });

  it('resolves each alias to a module export', async () => {
    const [contracts, messaging, common] = await Promise.all([
      import('@app/contracts'), import('@app/messaging'), import('@app/common'),
    ]);
    expect(contracts.ContractsModule).toBeDefined();
    expect(messaging.MessagingModule).toBeDefined();
    expect(common.CommonModule).toBeDefined();
  });
});
