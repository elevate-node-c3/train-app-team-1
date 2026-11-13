import { execSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';

describe('package scripts a newcomer will run', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const e2eSpecs = globSync('**/*.e2e-spec.ts', {
    exclude: (p) => p.includes('node_modules'),
  });

  it('keeps --passWithNoTests on test:e2e, which is what makes it exit 0 today', () => {
    expect(pkg.scripts['test:e2e']).toContain('--passWithNoTests');
  });

  // Avoid running the e2e suite twice once it has tests.
  it.skipIf(e2eSpecs.length > 0)(
    'test:e2e succeeds while there are no e2e specs',
    () => {
      expect(() =>
        execSync('npm run test:e2e', { stdio: 'pipe' }),
      ).not.toThrow();
    },
    180_000,
  );
});
