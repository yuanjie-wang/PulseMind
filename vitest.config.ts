import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Tests run in plain Node with the repo's real modules. The only thing that
// needs faking is `electron` (used by src/main/storage/index.ts for the
// templates dir) — see tests/stubs/electron.ts.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^electron$/, replacement: path.resolve(__dirname, 'tests/stubs/electron.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
