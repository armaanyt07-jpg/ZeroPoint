import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@zeropoint/types', replacement: pkg('types') },
      { find: '@zeropoint/crypto', replacement: pkg('crypto') },
      { find: '@zeropoint/pricing', replacement: pkg('pricing') },
      { find: '@zeropoint/providers', replacement: pkg('providers') },
      { find: '@zeropoint/schemas', replacement: pkg('schemas') },
      // Dashboard (apps/dashboard/tests): its "@/..." imports, and the `server-only`
      // guard, which throws outside a React Server Components bundle.
      { find: /^@\//, replacement: fileURLToPath(new URL('./apps/dashboard/', import.meta.url)) },
      { find: 'server-only', replacement: fileURLToPath(new URL('./tests/server-only-stub.ts', import.meta.url)) },
    ],
  },
  test: { include: ['tests/**/*.test.ts', 'apps/dashboard/tests/**/*.test.ts'] },
});
