import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/core/src/**/*.steps.ts'],
    exclude: ['node_modules', 'dist'],
    root: resolve(__dirname, '../..'), // Set root to monorepo root
  },
  resolve: {
    alias: {
      '@features': resolve(__dirname, '../../features'),
    },
  },
})