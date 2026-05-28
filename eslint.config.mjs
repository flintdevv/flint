import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import tsdoc from 'eslint-plugin-tsdoc';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/dist/**', '**/*.test.ts', '**/__tests__/**'],
    plugins: {
      tsdoc,
    },
    rules: {
      'tsdoc/syntax': 'warn',
    },
  },
);