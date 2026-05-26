import { defineConfig } from 'vitest/config';

// Mobile (React Native / Expo) unit tests — pure-JS modules in `src/utils/`
// plus component-adjacent helpers (e.g. chatMessageUserFlags for ChatMessage).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/utils/**/*.test.js'],
  },
});
