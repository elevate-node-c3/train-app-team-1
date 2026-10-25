import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function getTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...getTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const SERVICES = [
  'catalog',
  'gateway',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
];

describe('Monorepo Architecture Boundaries (§2.5)', () => {
  it('enforces that no app imports another app', () => {
    const violations: string[] = [];

    for (const service of SERVICES) {
      const serviceDir = join(process.cwd(), 'apps', service);
      const files = getTsFiles(serviceDir);

      const otherServices = SERVICES.filter((s) => s !== service);

      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, lineNum) => {
          // Check import/export statements
          if (/^\s*(import|export)\b.*from\s+['"][^'"]+['"]/.test(line)) {
            for (const other of otherServices) {
              const regex = new RegExp(
                `['"].*(apps/${other}|\\.\\./\\.\\./${other}|@app/${other})`,
              );
              if (regex.test(line)) {
                violations.push(
                  `${file}:${lineNum + 1} - ${service} illegally imports from ${other}: ${line.trim()}`,
                );
              }
            }
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * The libraries form a chain, not a web:
   *
   *   contracts <- common <- messaging
   *
   * This is the assertion that was missing. `@app/common` imported
   * `@app/messaging` for the broker health check, the retry budget and the
   * consumer defaults while `@app/messaging` imported `@app/common` back, and
   * the pair only booted because every edge was a deep subpath to a leaf that
   * happened to import nothing. One import added to the wrong file turned that
   * into a boot-time "cannot access before initialization".
   */
  it('keeps the libraries in one direction', () => {
    // Each lib may import only those to its left.
    const ORDER = ['contracts', 'common', 'messaging'];
    const violations: string[] = [];

    ORDER.forEach((lib, index) => {
      const allowed = new Set(ORDER.slice(0, index));

      for (const file of getTsFiles(join(process.cwd(), 'libs', lib))) {
        if (file.endsWith('.spec.ts')) continue;
        const lines = readFileSync(file, 'utf8').split('\n');

        lines.forEach((line, lineNum) => {
          if (!/^\s*(import|export)\b.*from\s+['"][^'"]+['"]/.test(line)) {
            return;
          }
          for (const other of ORDER) {
            if (other === lib || allowed.has(other)) continue;
            if (new RegExp(`from\\s+['"]@app/${other}\\b`).test(line)) {
              violations.push(
                `${file}:${lineNum + 1} - ${lib} must not import ${other}: ${line.trim()}`,
              );
            }
          }
        });
      }
    });

    expect(violations).toEqual([]);
  });
});
