import globals from 'globals'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  // scripts/.tmp is gitignored ad-hoc scratch (see .gitignore); scripts/*.js
  // are the CommonJS build entrypoints (build.js etc.), linted by nothing.
  { ignores: ['out/', 'node_modules/', 'scripts/*.js', 'scripts/.tmp/'] },

  // Base recommended rules
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // Node files (main, preload)
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Renderer files (React)
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: '18.3.1' },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  // platform-boot.js is a CLASSIC script (no module syntax — the CSP has no
  // unsafe-inline, and an external classic script is the one that may run at
  // parse time), evaluated in the renderer: browser globals, script source.
  {
    files: ['src/renderer/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },

  // Tests run under vitest in a node environment; a few mount components that
  // touch DOM globals, and some load CJS artifacts through require() — both
  // are correct at runtime here, so neither is a lint error.
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Scripts are node tooling; probe `page.evaluate` callbacks and fixture
  // pages reference browser globals from inside the same file — both sets
  // belong to this file's two worlds.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Repo-wide verdicts where the recommended defaults misread this codebase:
  {
    rules: {
      // `any` at IPC/JSON boundaries is deliberate (~129 sites); keep the count
      // visible as warnings instead of gating CI on type surgery.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Underscore-prefixed names are the codebase's "deliberately unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `catch {}` means "this migration/exec/best-effort ack may legitimately
      // fail" (database migrations, resume acks) — by design, everywhere.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Prettier compatibility
  eslintConfigPrettier,
)
