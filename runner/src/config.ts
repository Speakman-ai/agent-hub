/**
 * Per-profile config persistence for the runner. Keeps each profile's
 * (hub URL, runner id, token) in `~/.agent-hub-runner/<profile>/config.json`
 * so multiple runners can coexist on the same machine without sharing
 * state. The file is written 0600 because it stores a long-lived token.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';
import os from 'os';

export interface RunnerConfig {
  hubUrl: string;
  runnerId: string;
  token: string;
  /** Human label — same as the row's `name` in the control-plane DB. */
  name: string;
  /** Profile slug (defaults to "default"). */
  profile: string;
}

function profileRoot(profile: string): string {
  const base = process.env.AGENT_HUB_RUNNER_HOME || path.join(os.homedir(), '.agent-hub-runner');
  return path.join(base, profile);
}

export function configPath(profile: string): string {
  return path.join(profileRoot(profile), 'config.json');
}

export function readConfig(profile: string): RunnerConfig | null {
  const p = configPath(profile);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RunnerConfig>;
    if (
      typeof parsed.hubUrl !== 'string' ||
      typeof parsed.runnerId !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.name !== 'string'
    ) {
      return null;
    }
    return {
      hubUrl: parsed.hubUrl,
      runnerId: parsed.runnerId,
      token: parsed.token,
      name: parsed.name,
      profile: parsed.profile ?? profile,
    };
  } catch {
    return null;
  }
}

export function writeConfig(cfg: RunnerConfig): void {
  const dir = profileRoot(cfg.profile);
  mkdirSync(dir, { recursive: true });
  const p = configPath(cfg.profile);
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort — may fail on Windows */
  }
}
