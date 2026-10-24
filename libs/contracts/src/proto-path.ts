import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves a `.proto` file living in this library's `src/proto/` directory.
 *
 * The same library is loaded from three different shapes: TypeScript sources
 * through vitest, the tsc output under `dist/`, and the container image where
 * `dist/libs/contracts/src/proto` is populated by the Dockerfile. The four
 * candidates below are the shapes that actually occur; the first existing one
 * wins. The function is deliberately parameterised rather than duplicated per
 * proto — the search order is a build-layout fact, not a health.proto fact.
 */
export function getProtoPath(fileName: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  // 1. Beside the module in a source checkout or a compiled lib tree.
  const candidate1 = join(currentDir, 'proto', fileName);
  if (existsSync(candidate1)) return candidate1;

  // 2. One directory up, for layouts that place `proto/` beside `src/`.
  const candidate2 = join(currentDir, '..', 'proto', fileName);
  if (existsSync(candidate2)) return candidate2;

  // 3. A source checkout when the process was started from the repo root.
  const candidate3 = join(
    process.cwd(),
    'libs',
    'contracts',
    'src',
    'proto',
    fileName,
  );
  if (existsSync(candidate3)) return candidate3;

  // 4. The repository-root `dist/` tree used by the container image.
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

  // Returning the first candidate keeps the failure legible: the caller gets
  // an ENOENT naming the path it expected rather than `undefined`.
  return candidate1;
}
