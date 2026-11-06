import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig([
  {
    input: '../../packages/api-contracts/generated/http/openapi.json',
    output: '../../packages/api-contracts/generated/http/client',
    plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch'],
  },
  {
    input: '../../packages/api-contracts/generated/http/openapi.json',
    output: '../../packages/api-contracts/generated/http/public-client',
    parser: {
      filters: {
        operations: { exclude: ['/^[A-Z]+ \\/api\\/diagnostics(?:\\/|$)/'] },
      },
    },
    plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch'],
  },
]);
