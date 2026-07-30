import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

// audit-added G14: eslint-config-next via FlatCompat had a circular-reference
// crash on this project. Workaround: register the plugin directly and apply
// its `core-web-vitals` rule set as an explicit rules block.
export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '.claude/',
      '.next/',
      'next-env.d.ts',
      'components/ui/', // shadcn vendor code
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    plugins: {
      '@next/next': nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
