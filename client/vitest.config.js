import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Force React to load its development build during tests so @testing-library/react
  // can use `act`. Without this, some environments resolve to react.production.min.js
  // (which strips `act`) and every component render throws.
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/utils/**', 'src/hooks/**'],
    },
  },
});
