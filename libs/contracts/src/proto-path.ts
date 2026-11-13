import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds the first existing proto path across source, compiled and container
 * layouts.
 */
export function getProtoPath(fileName: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  // Beside this module in source or compiled layouts.
  const candidate1 = join(currentDir, 'proto', fileName);
  if (existsSync(candidate1)) return candidate1;

  // Layouts with proto beside src.
  const candidate2 = join(currentDir, '..', 'proto', fileName);
  if (existsSync(candidate2)) return candidate2;

  // Source checkout, relative to the repository root.
  const candidate3 = join(
    process.cwd(),
    'libs',
    'contracts',
    'src',
    'proto',
    fileName,
  );
  if (existsSync(candidate3)) return candidate3;

  // Container's dist tree, relative to the repository root.
  const candidate4 = join(
    process.cwd(),
    'dist',
    'libs',
    'contracts',
    'src',
    'proto',
    fileName,
  );
  if (existsSync(candidate4)) return candidate4;

  // Return the expected path so the loader reports ENOENT, not undefined.
  return candidate1;
}
