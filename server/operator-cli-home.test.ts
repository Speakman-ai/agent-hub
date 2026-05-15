import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
  defaultAgentHubDataDir,
  isDefaultAgentHubDataDir,
  operatorCliHome,
  ensureOperatorCliHome,
} from './operator-cli-home.js';

describe('operator-cli-home', () => {
  it('defaultAgentHubDataDir matches ~/.agent-hub/data', () => {
    expect(defaultAgentHubDataDir()).toBe(
      path.resolve(path.join(os.homedir(), '.agent-hub', 'data')),
    );
  });

  it('isDefaultAgentHubDataDir is true only for the canonical default path', () => {
    expect(isDefaultAgentHubDataDir(defaultAgentHubDataDir())).toBe(true);
    expect(isDefaultAgentHubDataDir('/data')).toBe(false);
    expect(isDefaultAgentHubDataDir(path.join(os.tmpdir(), 'ah-data'))).toBe(false);
  });

  it('operatorCliHome uses os.homedir() for the default data dir', () => {
    const d = defaultAgentHubDataDir();
    expect(operatorCliHome(d)).toBe(os.homedir());
  });

  it('operatorCliHome nests under dataDir for non-default paths', () => {
    expect(operatorCliHome('/data')).toBe('/data/global-cli-home');
    expect(operatorCliHome('/tmp/my-hub')).toBe(path.join('/tmp', 'my-hub', 'global-cli-home'));
  });

  it('ensureOperatorCliHome creates global-cli-home with safe perms', () => {
    const base = path.join(os.tmpdir(), `op-cli-${Date.now()}`);
    const home = ensureOperatorCliHome(base);
    expect(home).toBe(path.join(base, 'global-cli-home'));
  });

  it('treats empty dataDir as os.homedir()', () => {
    expect(operatorCliHome('')).toBe(os.homedir());
    expect(operatorCliHome(null as unknown as string)).toBe(os.homedir());
  });
});
