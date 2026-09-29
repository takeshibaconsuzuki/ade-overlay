import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/out/**',
      'dist/**',
      'node_modules/**',
      '.worktrees/**',
      '.vscode-test/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: [
      'electron.vite.config.ts',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/server/**/*.ts',
      'src/shared/node/**/*.ts',
      'tests/**/*.ts',
      'tests/**/*.mjs',
      'tests/**/*.cjs',
      'extensions/**/*.ts',
      'scripts/**/*.mjs',
    ],
    ignores: ['extensions/**/src/webview/**'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/editor-browser/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'src/renderer/**/*.{ts,tsx}',
      'src/shared/ui/**/*.{ts,tsx}',
      'extensions/**/src/webview/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: reactHooks.configs.recommended.rules,
  },
  prettier,
)
