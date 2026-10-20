import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `**/` so wrangler's build output under apps/worker/.wrangler (made by `pnpm dev`) is skipped too.
  { ignores: ['node_modules', '**/dist', '**/.wrangler', 'coverage', 'apps/dashboard'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
