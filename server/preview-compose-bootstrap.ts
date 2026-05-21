/**
 * Starter docker-compose suggestions for the Preview Setup wizard when a
 * project has no compose file yet. Compose-only — no legacy startScript path.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { classifyPackageJson, type KnownStack } from './scaffolding/detect-preview-defaults.js';

const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
const DEFAULT_ENTRY_SERVICE = 'web';

const STACK_ENTRY_PORTS: Record<KnownStack, number> = {
  vite: 5173,
  next: 3000,
  cra: 3000,
  astro: 4321,
  nuxt: 3000,
  expo: 19006,
};

const STACK_DEV_COMMAND: Record<KnownStack, string> = {
  vite: 'npm run dev -- --host 0.0.0.0',
  next: 'npm run dev',
  cra: 'npm start',
  astro: 'npm run dev',
  nuxt: 'npm run dev',
  expo: 'npm run web',
};

export interface ComposeBootstrapSuggestion {
  file: string;
  entryService: string;
  entryPort: number;
  services: string[];
  stack: KnownStack | 'unknown';
  composeYaml: string;
  captureRoutes: string[];
  idleTTL: number;
}

function readPkgShape(workspaceDir: string): Parameters<typeof classifyPackageJson>[0] | null {
  const pkgPath = path.join(workspaceDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Best-effort stack sniff from package.json (no script-mode fallback). */
export function detectStackHint(workspaceDir: string): KnownStack | 'unknown' {
  const root = readPkgShape(workspaceDir);
  if (root) {
    const stack = classifyPackageJson(root);
    if (stack) return stack;
  }
  const appsDir = path.join(workspaceDir, 'apps');
  if (!existsSync(appsDir)) return 'unknown';
  try {
    if (!statSync(appsDir).isDirectory()) return 'unknown';
    for (const entry of readdirSync(appsDir).sort()) {
      const child = path.join(appsDir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      const pkg = readPkgShape(child);
      if (!pkg) continue;
      const stack = classifyPackageJson(pkg);
      if (stack) return stack;
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export function buildComposeBootstrapYaml(
  stack: KnownStack | 'unknown',
  entryPort: number,
  devCommand: string,
): string {
  return [
    '# Created by Agent Hub Preview Setup wizard.',
    '# Adjust build/run steps to match your repo before relying on previews in production.',
    'services:',
    `  ${DEFAULT_ENTRY_SERVICE}:`,
    '    image: node:22-bookworm-slim',
    '    working_dir: /app',
    '    volumes:',
    '      - .:/app',
    `    command: sh -c "npm install && ${devCommand}"`,
    '    ports:',
    `      - "${entryPort}:${entryPort}"`,
    '    environment:',
    '      - NODE_ENV=development',
    '',
  ].join('\n');
}

export function suggestComposeBootstrap(workspaceDir: string): ComposeBootstrapSuggestion {
  const stack = detectStackHint(workspaceDir);
  const entryPort = stack !== 'unknown' ? STACK_ENTRY_PORTS[stack] : 3000;
  const devCommand = stack !== 'unknown' ? STACK_DEV_COMMAND[stack] : 'npm run dev';
  return {
    file: DEFAULT_COMPOSE_FILE,
    entryService: DEFAULT_ENTRY_SERVICE,
    entryPort,
    services: [DEFAULT_ENTRY_SERVICE],
    stack,
    composeYaml: buildComposeBootstrapYaml(stack, entryPort, devCommand),
    captureRoutes: ['/'],
    idleTTL: 600,
  };
}
