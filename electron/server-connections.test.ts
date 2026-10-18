import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerConnectionStore } from './server-connections.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Seed the exact filenames and fields used by older Electron versions.
describe('Server connection file compatibility', () => {
  it('retains bookmarks, API keys and active selection across restarts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-server-connections-'));
    dirs.push(dir);
    const servers = [
      {
        id: 'old-a',
        name: 'Alpha',
        remote_url: 'https://a.test',
        api_key: 'a-key',
        color: '#123456',
      },
      {
        id: 'old-b',
        name: 'Beta',
        remote_url: 'https://b.test',
        api_key: 'b-key',
        color: '#654321',
      },
    ];
    writeFileSync(path.join(dir, 'remote-orgs.json'), JSON.stringify(servers));
    writeFileSync(path.join(dir, 'active-org.json'), JSON.stringify({ activeOrgId: 'old-b' }));
    const store = createServerConnectionStore(dir);
    expect(store.readServers()).toEqual(servers);
    expect(store.readActiveId()).toBe('old-b');
    store.saveActiveId('old-a');
    store.saveServers([{ ...servers[0], name: 'Renamed' }, servers[1]]);
    const restarted = createServerConnectionStore(dir);
    expect(restarted.readActiveId()).toBe('old-a');
    expect(restarted.readServers()).toEqual([{ ...servers[0], name: 'Renamed' }, servers[1]]);
    expect(JSON.parse(readFileSync(path.join(dir, 'active-org.json'), 'utf8'))).toEqual({
      activeOrgId: 'old-a',
    });
  });

  it('keeps the legacy empty fallback for missing or unreadable files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-server-connections-'));
    dirs.push(dir);
    const store = createServerConnectionStore(dir);
    expect(store.readServers()).toEqual([]);
    expect(store.readActiveId()).toBeNull();
    writeFileSync(path.join(dir, 'remote-orgs.json'), '{');
    writeFileSync(path.join(dir, 'active-org.json'), '{');
    expect(store.readServers()).toEqual([]);
    expect(store.readActiveId()).toBeNull();
  });
});
