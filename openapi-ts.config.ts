import { defineConfig } from '@hey-api/openapi-ts'
import { OPENAPI_GENERATED_SPEC_PATH } from './src/server/config'

export default defineConfig({
  input: OPENAPI_GENERATED_SPEC_PATH,
  output: 'src/api/generated',
  plugins: [
    '@hey-api/typescript',
    {
      name: '@hey-api/client-fetch',
      baseUrl: false,
    },
    '@hey-api/sdk',
  ],
})
