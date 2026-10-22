import { execSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';

// A skeleton's npm scripts are the first thing anyone runs, and the first
// thing a CI config wires up. A script that exits non-zero on a clean clone
// reads as a broken repo.
describe('package scripts a newcomer will run', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const e2eSpecs = globSync('**/*.e2e-spec.ts', { exclude: (p) => p.includes('node_modules') });

  it('keeps --passWithNoTests on test:e2e, which is what makes it exit 0 today', () => {
    expect(pkg.scripts['test:e2e']).toContain('--passWithNoTests');
  });

  // Runs the real script while part 1 has no e2e specs. It stops running once
  // part 2 adds one: shelling out to the full e2e suite from inside the unit
  // suite would run every e2e test twice and make `npm test` as slow as it.
  it.skipIf(e2eSpecs.length > 0)('test:e2e succeeds while there are no e2e specs', () => {
    expect(() => execSync('npm run test:e2e', { stdio: 'pipe' })).not.toThrow();
  }, 180_000);
});
