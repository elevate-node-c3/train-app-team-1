import { execSync } from 'node:child_process';

// A skeleton's npm scripts are the first thing anyone runs, and the first
// thing a CI config wires up. A script that exits non-zero on a clean clone
// reads as a broken repo.
describe('package scripts a newcomer will run', () => {
  it('test:e2e succeeds while there are no e2e specs yet', () => {
    expect(() => execSync('npm run test:e2e', { stdio: 'pipe' })).not.toThrow();
  }, 180_000);
});
