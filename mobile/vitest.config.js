import { defineConfig } from 'vitest/config';

// Mobile (React Native / Expo) unit tests — scoped to pure-JS modules in
// `src/utils/` (including SessionTail lazy-fetch helpers used by components).
// Full RN component tests need the Expo/jest-expo runner and stay out of scope.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/utils/**/*.test.js'],
  },
});
