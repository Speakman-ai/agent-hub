import { defineConfig } from 'vitest/config';

// Mobile (React Native / Expo) unit tests — scoped to pure-JS utility
// modules in `src/utils/`. Component tests need the Expo/jest-expo runner
// and are intentionally out of scope here.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/utils/**/*.test.js'],
  },
});
