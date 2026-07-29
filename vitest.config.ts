import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@agent-comm/application-catalog': fileURLToPath(
        new URL('./packages/application-catalog/src/index.ts', import.meta.url),
      ),
      '@agent-comm/application-spec': fileURLToPath(
        new URL('./packages/application-spec/src/index.ts', import.meta.url),
      ),
      '@agent-comm/a2a-binding': fileURLToPath(
        new URL('./packages/a2a-binding/src/index.ts', import.meta.url),
      ),
      '@agent-comm/benchmark': fileURLToPath(new URL('./packages/benchmark/src/index.ts', import.meta.url)),
      '@agent-comm/client-sdk': fileURLToPath(new URL('./packages/client-sdk/src/index.ts', import.meta.url)),
      '@agent-comm/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@agent-comm/delivery': fileURLToPath(new URL('./packages/delivery/src/index.ts', import.meta.url)),
      '@agent-comm/gateway-a2a': fileURLToPath(
        new URL('./packages/gateway-a2a/src/index.ts', import.meta.url),
      ),
      '@agent-comm/harness-claude-code': fileURLToPath(
        new URL('./packages/harness-claude-code/src/index.ts', import.meta.url),
      ),
      '@agent-comm/harness-codex': fileURLToPath(
        new URL('./packages/harness-codex/src/index.ts', import.meta.url),
      ),
      '@agent-comm/ingress-polling': fileURLToPath(
        new URL('./packages/ingress-polling/src/index.ts', import.meta.url),
      ),
      '@agent-comm/ingress-process': fileURLToPath(
        new URL('./packages/ingress-process/src/index.ts', import.meta.url),
      ),
      '@agent-comm/ingress-webhook': fileURLToPath(
        new URL('./packages/ingress-webhook/src/index.ts', import.meta.url),
      ),
      '@agent-comm/manager-workers': fileURLToPath(
        new URL('./applications/manager-workers/src/index.ts', import.meta.url),
      ),
      '@agent-comm/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
      '@agent-comm/request-response': fileURLToPath(
        new URL('./applications/request-response/src/index.ts', import.meta.url),
      ),
      '@agent-comm/runtime-ingress': fileURLToPath(
        new URL('./packages/runtime-ingress/src/index.ts', import.meta.url),
      ),
      '@agent-comm/runtime-supervisor': fileURLToPath(
        new URL('./packages/runtime-supervisor/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'applications/*/test/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 15_000,
  },
})
