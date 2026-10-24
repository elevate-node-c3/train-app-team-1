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
});
