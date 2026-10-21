import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
    conditions: ['development', 'browser'],
  },
  // Force React to load its development build during tests so @testing-library/react
  // can use `act`. Without this, some environments resolve to react.production.min.js
  // (which strips `act`) and every component render throws.
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  test: {
    // Telemetry endpoints are unset by default (self-hosted builds don't phone
    // home). Configure a bug-report intake for the test run so the
    // record-on-error replay suite exercises the *configured* path; the
    // disabled-default behavior is covered by dedicated resolver tests. The
    // release bucket is intentionally left unset so version.ts tests its
    // disabled default.
    env: {
      VITE_BUG_REPORT_ENDPOINT: 'https://hub.example.test/api/bug-reports',
    },
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/utils/**', 'src/hooks/**'],
    },
  },
});
