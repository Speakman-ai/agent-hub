#!/usr/bin/env -S npx tsx
/**
 * agent-hub-runner CLI — phase 1.
 *
 *   register   POST /api/runners with the operator's API key, save token.
 *   start      Connect to the control plane and answer pings forever.
 *   status     Print saved config (token redacted) for the active profile.
 *
 * All commands accept `--profile <name>` to scope state to a separate
 * directory, enabling N runners on one machine without conflict.
 */
import { argv, exit } from 'process';
import { readConfig, writeConfig, configPath, type RunnerConfig } from './config.js';
import { RunnerClient } from './client.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const [command, ...rest] = rawArgs;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command: command ?? '', flags };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | null {
  const v = flags[key];
  return typeof v === 'string' ? v : null;
}

function profileFromFlags(flags: Record<string, string | boolean>): string {
  return flagStr(flags, 'profile') ?? 'default';
}

function usage(): void {
  console.log(`agent-hub-runner — phase 1

Usage:
  agent-hub-runner register --hub-url <url> --api-key <key> --name <name> [--profile <p>] [--org-id <id>]
  agent-hub-runner start    [--profile <p>]
  agent-hub-runner status   [--profile <p>]

Environment:
  AGENT_HUB_API_KEY       API key for register (avoids --api-key in ps output)
  AGENT_HUB_RUNNER_HOME   override config root (default: ~/.agent-hub-runner)
`);
}

async function cmdRegister(flags: Record<string, string | boolean>): Promise<number> {
  const hubUrl = flagStr(flags, 'hub-url');
  const apiKey = flagStr(flags, 'api-key') ?? process.env.AGENT_HUB_API_KEY ?? null;
  const name = flagStr(flags, 'name');
  const orgId = flagStr(flags, 'org-id') ?? undefined;
  const profile = profileFromFlags(flags);

  if (!hubUrl || !apiKey || !name) {
    console.error('register requires --hub-url, --api-key (or AGENT_HUB_API_KEY env), and --name');
    return 2;
  }

  if (flagStr(flags, 'api-key')) {
    console.warn('Warning: --api-key is visible in `ps` output on shared machines. Prefer AGENT_HUB_API_KEY env var.');
  }

  const url = hubUrl.replace(/\/+$/, '') + '/api/runners';
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ name, orgId }),
    });
  } catch (err) {
    console.error('register: network error: ' + (err as Error).message);
    return 1;
  }

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`register failed: HTTP ${resp.status} — ${body}`);
    return 1;
  }

  const body = (await resp.json()) as { runner: { id: string }; token: string };
  const cfg: RunnerConfig = {
    hubUrl,
    runnerId: body.runner.id,
    token: body.token,
    name,
    profile,
  };
  writeConfig(cfg);
  console.log(`Registered runner "${name}" (${body.runner.id}) — config saved to ${configPath(profile)}`);
  return 0;
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<number> {
  const profile = profileFromFlags(flags);
  const cfg = readConfig(profile);
  if (!cfg) {
    console.error(`No config for profile "${profile}". Run \`agent-hub-runner register …\` first.`);
    return 2;
  }

  const client = new RunnerClient({ config: cfg });
  client.start();

  const shutdown = (): void => {
    console.log('\n[runner] shutting down…');
    client.stop();
    setTimeout(() => exit(0), 250).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Block forever — `start()` schedules timers that keep the loop alive.
  return new Promise<number>(() => {});
}

function cmdStatus(flags: Record<string, string | boolean>): number {
  const profile = profileFromFlags(flags);
  const cfg = readConfig(profile);
  if (!cfg) {
    console.log(`(no config for profile "${profile}")`);
    return 0;
  }
  console.log({
    profile: cfg.profile,
    name: cfg.name,
    runnerId: cfg.runnerId,
    hubUrl: cfg.hubUrl,
    token: cfg.token.slice(0, 6) + '…(redacted)',
    configPath: configPath(profile),
  });
  return 0;
}

async function main(): Promise<void> {
  // argv[0] = node, argv[1] = script. Skip both.
  const { command, flags } = parseArgs(argv.slice(2));
  let code = 0;
  switch (command) {
    case 'register':
      code = await cmdRegister(flags);
      break;
    case 'start':
      code = await cmdStart(flags);
      break;
    case 'status':
      code = cmdStatus(flags);
      break;
    case '':
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      code = 2;
  }
  if (code !== 0) exit(code);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
