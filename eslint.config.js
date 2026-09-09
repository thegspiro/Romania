import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/vendor/**',
      'coverage/**',
      // Python territory, and third-party JavaScript that ships inside
      // installed packages must not be linted as if it were ours.
      'worker/**',
      '.venv/**',
      'venv/**',
      'data/**',
    ],
  },

  // Type-aware linting, scoped to TypeScript. The typed rules need a program,
  // so they must not be applied to plain JavaScript files -- doing so fails
  // with "you have used a rule which requires type information".
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // The server logs through Fastify's logger; stray console output would
      // bypass log levels and redaction.
      'no-console': 'error',
    },
  },

  {
    // Terminal programs; writing to stdout/stderr is their interface.
    files: ['src/cli/**/*.ts', 'src/db/migrate.ts'],
    rules: { 'no-console': 'off' },
  },

  // Build scripts and browser assets: untyped, plain JavaScript.
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },

  prettier,
);
