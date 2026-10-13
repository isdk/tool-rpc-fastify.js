// Flat config (ESLint 9+). Replaces the legacy .eslintrc.yml, which ESLint 10
// no longer reads. Same intent as before: antfu's preset + prettier overrides,
// the tsdoc plugin, and the same rule exceptions.
import antfu from '@antfu/eslint-config'
import prettier from 'eslint-config-prettier/flat'
import tsdoc from 'eslint-plugin-tsdoc'

export default [
  // the antfu preset returns a thenable composer; ESLint wants a plain array
  ...(await antfu({
    typescript: true,
    yaml: true,
    // the repo formats with prettier, so antfu's stylistic rules are off
    stylistic: false,
    ignores: [
      'web/**',
      'docs/**',
      'dist/**',
      // markdown belongs to neither tool: antfu would rewrite the code blocks
      // inside the READMEs, and prettier only normalizes prose/tables there
      // (`embeddedLanguageFormatting: off` in .prettierrc keeps the examples as
      // written — reformatting embedded code churns a hundred lines per README
      // and mangles aligned continuation comments, which kills reviewability).
      // Code is eslint's job; css has no parser here at all, so it stays prettier's.
      '**/*.md',
    ],
  })),
  {
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'off',
      'no-cond-assign': 'off',
      'yml/plain-scalar': 'off',
      'yml/quotes': 'off',
      'unicorn/prefer-number-properties': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // opinionated key order; the existing tsconfig/prettier layout wins
      'jsonc/sort-keys': 'off',
      // the transport reports mounted routes and the bound address on stdout
      // by design (see the README quick start), so console.log stays allowed
      'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
    },
  },
  {
    // vitest globals used by the setup file, which is not matched as a test file
    files: ['setupVitest.mjs'],
    languageOptions: {
      globals: { vi: 'readonly', globalThis: 'readonly' },
    },
  },
  // keep formatting decisions with prettier (the repo has a .prettierrc)
  prettier,
]
