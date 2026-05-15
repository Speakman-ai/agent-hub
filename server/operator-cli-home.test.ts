import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { operatorCliHomePath, ensureOperatorCliHome } from './operator-cli-home.js';

describe('operator-cli-home', () => {
  const realHomedir = os.homedir.bind(os);

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses real homedir when dataDir is the default ~/.agent-hub/data', () => {
    expect(operatorCliHomePath('/mock/home/.agent-hub/data')).toBe('/mock/home');
    expect(ensureOperatorCliHome('/mock/home/.agent-hub/data')).toBe('/mock/home');
  });

  it('uses a subdirectory under a non-default dataDir', () => {
    const tmp = path.join(realHomedir(), 'operator-cli-home-test-' + String(Date.now()));
    mkdirSync(tmp, { recursive: true });
    try {
      expect(operatorCliHomePath(tmp)).toBe(path.join(tmp, 'operator-cli-home'));
      const ensured = ensureOperatorCliHome(tmp);
      expect(ensured).toBe(path.join(tmp, 'operator-cli-home'));
      expect(existsSync(ensured)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
