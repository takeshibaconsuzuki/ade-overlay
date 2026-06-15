import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const projectRoot = dirname(fileURLToPath(import.meta.url))

function toProjectPath(path) {
  return relative(projectRoot, path).split(sep).join('/')
}

function isInPath(path, directory) {
  return path === directory || path.startsWith(`${directory}/`)
}

function resolveImportPath(importerPath, importSource) {
  if (importSource.startsWith('.')) {
    return toProjectPath(
      resolve(projectRoot, dirname(importerPath), importSource),
    )
  }

  if (importSource.startsWith('src/')) {
    return importSource
  }

  return null
}

const boundaries = {
  rules: {
    'shared-api-boundaries': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          apiNodeImport:
            'src/api must stay node-free so the renderer can import it.',
          apiRuntimeImport:
            'src/api is a shared contract layer and must not depend on runtime source layers.',
          serverToPreload:
            'Server API contracts must not depend on preload API contracts.',
          preloadToServer:
            'Preload API contracts must not depend on server API contracts.',
          rendererNodeImport: 'Renderer code must stay node-free.',
          rendererRuntimeImport:
            'Renderer code may only import shared API contracts from src/api.',
        },
      },
      create(context) {
        const importerPath = toProjectPath(context.filename)
        const isApi = isInPath(importerPath, 'src/api')
        const isServerApi = isInPath(importerPath, 'src/api/server')
        const isPreloadApi = isInPath(importerPath, 'src/api/preload')
        const isRenderer = isInPath(importerPath, 'src/renderer')

        function checkImport(node) {
          const importSource = node.source?.value
          if (typeof importSource !== 'string') {
            return
          }

          if (isApi && importSource.startsWith('node:')) {
            context.report({ node, messageId: 'apiNodeImport' })
            return
          }

          if (isRenderer && importSource.startsWith('node:')) {
            context.report({ node, messageId: 'rendererNodeImport' })
            return
          }

          const resolvedPath = resolveImportPath(importerPath, importSource)
          if (!resolvedPath) {
            return
          }

          if (
            isApi &&
            ['src/server', 'src/main', 'src/preload', 'src/renderer'].some(
              (directory) => isInPath(resolvedPath, directory),
            )
          ) {
            context.report({ node, messageId: 'apiRuntimeImport' })
            return
          }

          if (isServerApi && isInPath(resolvedPath, 'src/api/preload')) {
            context.report({ node, messageId: 'serverToPreload' })
            return
          }

          if (isPreloadApi && isInPath(resolvedPath, 'src/api/server')) {
            context.report({ node, messageId: 'preloadToServer' })
            return
          }

          if (
            isRenderer &&
            ['src/server', 'src/main', 'src/preload'].some((directory) =>
              isInPath(resolvedPath, directory),
            )
          ) {
            context.report({ node, messageId: 'rendererRuntimeImport' })
          }
        }

        return {
          ExportAllDeclaration: checkImport,
          ExportNamedDeclaration: checkImport,
          ImportDeclaration: checkImport,
        }
      },
    },
  },
}

export default tseslint.config(
  {
    ignores: ['out/**', 'node_modules/**', 'src/api/server/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Strip unused imports automatically on `--fix`. The plugin owns unused
    // detection so it replaces the stock `no-unused-vars` rule (which can flag
    // the same bindings but cannot remove dead imports).
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
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
    // `src/api` contains node-free shared API contracts. `src/api/server` owns
    // the HTTP server API contract; `src/api/preload` owns the Electron preload
    // API contract. Keep both free of Node built-ins and of any dependency on
    // runtime source layers so every consumer can import them safely.
    // `src/api/server/generated` is excluded via the global `ignores` above.
    files: ['src/api/**/*.ts'],
    plugins: {
      boundaries,
    },
    rules: {
      'boundaries/shared-api-boundaries': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      boundaries,
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The renderer is unprivileged browser code: it may only reach privileged
      // or server contracts through the node-free `src/api` layer, never
      // directly into server/main/preload, and it must not import Node built-ins.
      'boundaries/shared-api-boundaries': 'error',
    },
  },
  prettier,
)
