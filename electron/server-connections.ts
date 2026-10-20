import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface SavedServer {
  remote_url?: string;
  [field: string]: unknown;
}

/** Origin-independent bookmarks. Legacy filenames and fields stay readable by older clients. */
export function createServerConnectionStore(userDataDir: string) {
  const serversPath = path.join(userDataDir, 'remote-orgs.json');
  const activePath = path.join(userDataDir, 'active-org.json');
  return {
    readServers(): SavedServer[] {
      try {
        if (existsSync(serversPath)) return JSON.parse(readFileSync(serversPath, 'utf8'));
      } catch {}
      return [];
    },
    saveServers(servers: SavedServer[]) {
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(serversPath, JSON.stringify(servers, null, 2) + '\n');
    },
    readActiveId(): string | null {
      try {
        if (existsSync(activePath)) {
          return JSON.parse(readFileSync(activePath, 'utf8')).activeOrgId || null;
        }
      } catch {}
      return null;
    },
    saveActiveId(serverId: string) {
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(activePath, JSON.stringify({ activeOrgId: serverId }) + '\n');
    },
  };
}
