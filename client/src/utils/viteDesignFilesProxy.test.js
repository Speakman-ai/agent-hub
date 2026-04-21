import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const viteConfigPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vite.config.js');

describe('Vite dev proxy', () => {
  it('proxies /design-files to the API port so Electron+Vite can load design artifacts', () => {
    const raw = readFileSync(viteConfigPath, 'utf8');
    expect(raw).toMatch(/['"]\/design-files['"]\s*:\s*`http:\/\/localhost:\$\{apiPort\}`/);
  });
});
