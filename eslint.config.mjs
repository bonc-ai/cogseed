import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '.build/**',
      '.cogseed/**',
      'data/**',
      'dist/**',
      'dist-dev/**',
      'node_modules/**',
      'output/**',
      'resources/**',
      'src/renderer/vendor/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs,ts}'],
    linterOptions: {
      // The codebase contains legacy disable directives from an earlier ESLint
      // setup. Keep them from masking the baseline checks while migration is
      // completed separately.
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-debugger': 'error',
      'no-dupe-else-if': 'error',
      'no-loss-of-precision': 'error',
      'no-unreachable': 'error',
      'no-unused-private-class-members': 'error',
      'no-unsafe-finally': 'error',
    },
  },
];
