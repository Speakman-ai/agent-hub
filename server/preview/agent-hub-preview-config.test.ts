import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseDevServerConfig } from '../dev-server-config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface PreviewSnapshot {
  prEnv?: {
    preview?: { enabled?: boolean; compose?: unknown };
    devServer?: unknown;
  };
}

function readSnapshot(): PreviewSnapshot {
  const raw = readFileSync(path.join(repoRoot, '.agent-hub', 'preview.json'), 'utf8');
  return JSON.parse(raw) as PreviewSnapshot;
}

function parseSnapshotDevServer() {
  const parsed = parseDevServerConfig(readSnapshot().prEnv?.devServer ?? {});
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('Agent Hub preview config', () => {
  it('is a devServer config that passes the shared validator', () => {
    const parsed = parseDevServerConfig(readSnapshot().prEnv?.devServer ?? {});
    expect(parsed.ok ? null : parsed.error).toBeNull();
  });

  it('carries no app-wrapping compose block', () => {
    // The compose runtime is being deleted; a leftover `entryService` here
    // would make `startSessionPreview` select it over the dev server. A
    // devServer-only project keeps `preview` as the disabled round-trip slot —
    // `isPreviewConfigured` / `handlePreviewBlock` gate on devServer instead.
    expect(readSnapshot().prEnv?.preview?.compose).toBeUndefined();
  });

  it('exports the nested Hub env from startCommand, not devServer.env', () => {
    const cfg = parseSnapshotDevServer();
    // AGENT_HUB_* is a reserved key namespace the schema rejects in `env`, so
    // the nested Hub's data-dir isolation and API port have to be exported by
    // the start command itself. Losing AGENT_HUB_DATA_DIR would point the
    // preview's Hub at the HOST Hub's SQLite database.
    expect(cfg.startCommand).toContain('AGENT_HUB_PREVIEW=1');
    expect(cfg.startCommand).toContain('.agent-hub-preview/data');
    expect(cfg.startCommand).toMatch(/AGENT_HUB_PORT=\d+/);
    expect(cfg.env).toEqual({});
  });

  it('maps the client as primary and pins the API port to the one it exports', () => {
    const cfg = parseSnapshotDevServer();
    const primary = cfg.portMap.find((p) => p.primary);
    expect(primary?.internalPort).toBe(3050);

    // The API portMap entry must match AGENT_HUB_PORT — the runtime maps out
    // exactly the configured ports, so a drifted pair publishes a port nothing
    // is listening on.
    const exported = cfg.startCommand.match(/AGENT_HUB_PORT=(\d+)/)?.[1];
    const api = cfg.portMap.find((p) => !p.primary);
    expect(api?.internalPort).toBe(Number(exported));
  });

  it('keeps the nested API off the outer Hub port', () => {
    // On the host session-env backend the dev server runs in the SAME network
    // namespace as the Hub, which already owns 3051 — reusing it is EADDRINUSE.
    const cfg = parseSnapshotDevServer();
    expect(cfg.startCommand).not.toMatch(/AGENT_HUB_PORT=3051\b/);
  });
});
