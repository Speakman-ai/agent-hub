import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveElectronDevUserDataDir } from './resolve-user-data-dir.js';

describe('resolveElectronDevUserDataDir', () => {
  it('uses ~/.agent-hub/data when AGENT_HUB_DATA_DIR is unset', () => {
    const dir = resolveElectronDevUserDataDir({}, () => '/home/tester');
    expect(dir).toBe(path.join('/home/tester', '.agent-hub', 'data'));
  });

  it('respects AGENT_HUB_DATA_DIR when set', () => {
    expect(
      resolveElectronDevUserDataDir({ AGENT_HUB_DATA_DIR: '/tmp/hub-data' }, () => '/home/x'),
    ).toBe('/tmp/hub-data');
  });

  it('trims AGENT_HUB_DATA_DIR whitespace', () => {
    expect(
      resolveElectronDevUserDataDir({ AGENT_HUB_DATA_DIR: '  /tmp/spaced  ' }, () => '/home/x'),
    ).toBe('/tmp/spaced');
  });
});
