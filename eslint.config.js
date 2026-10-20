import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', '.wrangler', 'coverage', 'apps/dashboard'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
