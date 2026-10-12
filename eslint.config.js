import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['out/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'electron.vite.config.ts',
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      'src/desktop/**/*.ts',
      'src/shared/**/*.ts',
      'src/server/**/*.ts',
      'tests/**/*.{ts,mjs}',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/desktop/**/renderer/**/*.{ts,tsx}'],
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
