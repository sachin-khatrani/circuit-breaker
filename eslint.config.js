import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/node_modules/**', '**/coverage/**']),

  // TypeScript everywhere, with type-aware rules.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Plain JS tooling files (this config, the server build script).
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['apps/server/**/*.ts', 'packages/shared/**/*.ts', 'apps/client/*.config.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['apps/client/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },

  // Scene components own three.js objects (materials, buffers, instance matrices) that are
  // mutated every frame inside useFrame, which is how React Three Fiber is meant to be used.
  // The React Compiler's immutability rule assumes memoised values are never mutated; the
  // compiler is not used in this project, so the rule is off for scene code only.
  {
    files: ['apps/client/src/scene/**/*.tsx'],
    rules: { 'react-hooks/immutability': 'off' },
  },

  // Formatting is Prettier's job; switch off any stylistic rules that would fight it.
  prettier,
);
