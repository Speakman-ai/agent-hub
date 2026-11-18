import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// The WoW addon experiment was removed; the desktop app must not watch game folders.
describe('electron main without the WoW bridge', () => {
  it('does not start or import a WoW bridge', () => {
    const main = readFileSync(path.join(here, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/wow-bridge|startWowBridge|wowInstallRoots/i);
  });

  it('ships no addon or bridge sources', () => {
    expect(existsSync(path.join(root, 'integrations', 'wow-addon'))).toBe(false);
    expect(existsSync(path.join(here, 'wow-bridge.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'server', 'routes', 'me-sessions.ts'))).toBe(false);
  });
});
