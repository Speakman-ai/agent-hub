import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Mobile (React Native / Expo) unit tests — pure-JS modules in `src/utils/`
// plus component-adjacent helpers (e.g. chatMessageUserFlags for ChatMessage).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.join(repoRoot, 'shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/utils/**/*.test.ts'],
  },
});
