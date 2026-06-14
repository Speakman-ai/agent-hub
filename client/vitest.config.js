import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // Mirror vite.config.js so component tests can import the rrweb-player UMD
    // bundle as raw text (the package exports map hides the dist subpath). Regex
    // prefix form preserves the `?raw` query through the rewrite.
    alias: [
      {
        find: /^rrweb-player-umd/,
        replacement: path.resolve(
          __dirname,
          'node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs',
        ),
      },
    ],
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
