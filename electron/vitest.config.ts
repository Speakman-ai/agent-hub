import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    // Mock Electron modules that aren't available in Node test environments
    alias: {
      electron: new URL('./test/electron-mock.ts', import.meta.url).pathname,
    },
  },
});
