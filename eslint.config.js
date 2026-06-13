import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['out/**', 'node_modules/**', 'src/api/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'electron.vite.config.ts',
      'openapi-ts.config.ts',
      'scripts/**/*.ts',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/server/**/*.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
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
