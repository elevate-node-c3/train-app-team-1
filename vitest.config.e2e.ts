import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Restate Vitest's defaults when overriding `exclude`; otherwise the
    // dependency tree and build output are scanned for specs.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
