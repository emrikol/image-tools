import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/', 'calibration/venv/', 'encoding-cache/', 'encoding-cache-*/',
      'test-images/', 'DIV2K_valid_HR/', 'assets/', '**/*.json',
    ],
  },
  js.configs.recommended,
  {
    // Node ESM sources (CLI, lib, calibration, tests)
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Browser demo
    files: ['web/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
];
