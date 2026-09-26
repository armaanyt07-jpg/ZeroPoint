import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@zeropoint/types': pkg('types'),
      '@zeropoint/crypto': pkg('crypto'),
      '@zeropoint/pricing': pkg('pricing'),
      '@zeropoint/providers': pkg('providers'),
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
