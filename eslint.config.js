import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.pulse/**', '.pulse-*/**'],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Build scripts intentionally log progress.
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
    },
    settings: {
      'import-x/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      // Correctness rules that are cheap to enforce everywhere.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-useless-call': 'error',
      'no-useless-concat': 'error',
      'no-useless-return': 'error',
      'no-template-curly-in-string': 'error',
      'no-promise-executor-return': 'error',
      'no-return-assign': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'require-atomic-updates': 'error',
      curly: ['error', 'multi-line'],

      // TypeScript-specific hygiene around imports, switches and promises.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/no-meaningless-void-operator': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      // Numbers are safe and intentional in CLI/report interpolation.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `console` is the CLI's output surface; banning it would force a wrapper
      // that adds nothing. Prefer the reporter modules in new code.
      'no-console': 'off',

      // Import graph hygiene.
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-duplicates': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests deliberately build partial fixtures and assert on narrowed values.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Deeply nested Lighthouse/axe fixtures are built as partial JSON on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      // `${VAR}` appears literally in auth and config fixtures.
      'no-template-curly-in-string': 'off',
      // Async stubs and deferred resolvers are normal in test doubles.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-promise-executor-return': 'off',
      // Sequential flow tests mutate shared fixture state between awaited runs.
      'require-atomic-updates': 'off',
    },
  },
);
