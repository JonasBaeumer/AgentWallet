import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Existing codebase has many `any` uses — warn rather than block; clean up separately
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow _-prefixed params/vars to signal intentionally unused
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Existing codebase has many `any` uses — warn rather than block; clean up separately
      '@typescript-eslint/no-explicit-any': 'warn',
      // require() after jest.mock() is idiomatic Jest — static imports can't follow jest.mock()
      '@typescript-eslint/no-require-imports': 'off',
      // jest.Mock callbacks commonly type args as Function; tighten in a separate cleanup
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      // Allow _-prefixed variables to suppress unused-var warnings in destructuring/mocks
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  prettierConfig,
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'],
  },
];
