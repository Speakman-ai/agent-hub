/**
 * Discover compose files and per-service ports (monorepo-friendly).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { extractFirstContainerPort } from './scaffolding/detect-compose-preview.js';

const COMPOSE_FILENAMES = [
  // Agent Hub / project convention — prefer over generic docker-compose.yml
  // (repos often keep a wizard stub at docker-compose.yml alongside the
  // real preview stack in compose.preview.yml).
  'compose.preview.yml',
  'compose.preview.yaml',
  'docker-compose.yml',
  'compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
];

const PREFERRED_ENTRY_SERVICES = ['frontend', 'web', 'client', 'app', 'ui', 'api', 'gateway'];
const SEARCH_SUBDIRS = ['apps', 'services', 'packages', 'deploy', 'docker', 'infra'];

export interface ComposeServiceInfo {
  name: string;
  entryPort: number | null;
}

export interface ComposeFileCandidate {
  file: string;
  services: ComposeServiceInfo[];
  suggestedEntryService: string | null;
  suggestedEntryPort: number;
}

function pickEntryService(services: string[]): string | null {
  for (const c of PREFERRED_ENTRY_SERVICES) {
    if (services.includes(c)) return c;
  }
  return services[0] ?? null;
}

function parseComposeFile(absPath: string, relFile: string): ComposeFileCandidate | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const servicesRaw = (parsed as Record<string, unknown>).services;
  if (!servicesRaw || typeof servicesRaw !== 'object' || Array.isArray(servicesRaw)) {
    return null;
  }
  const serviceNames = Object.keys(servicesRaw as Record<string, unknown>);
  if (serviceNames.length === 0) return null;

  const services: ComposeServiceInfo[] = serviceNames.map((name) => {
    const svc = (servicesRaw as Record<string, unknown>)[name] as
      | Record<string, unknown>
      | undefined;
    let entryPort: number | null = null;
    if (svc && Array.isArray(svc.ports)) {
      entryPort = extractFirstContainerPort(svc.ports);
    }
    return { name, entryPort };
  });

  const suggestedEntryService = pickEntryService(serviceNames);
  let suggestedEntryPort = 3000;
  if (suggestedEntryService) {
    const match = services.find((s) => s.name === suggestedEntryService);
    if (match?.entryPort) suggestedEntryPort = match.entryPort;
  }

  return { file: relFile, services, suggestedEntryService, suggestedEntryPort };
}

function listComposePaths(workspaceDir: string): string[] {
  const found: string[] = [];
  for (const name of COMPOSE_FILENAMES) {
    const root = path.join(workspaceDir, name);
    if (existsSync(root)) found.push(name);
  }
  for (const sub of SEARCH_SUBDIRS) {
    const subDir = path.join(workspaceDir, sub);
    if (!existsSync(subDir)) continue;
    let entries: string[];
    try {
      if (!statSync(subDir).isDirectory()) continue;
      entries = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(subDir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const name of COMPOSE_FILENAMES) {
        const candidate = path.join(child, name);
        if (existsSync(candidate)) {
          found.push(path.join(sub, entry, name).replace(/\\/g, '/'));
        }
      }
    }
  }
  return [...new Set(found)].sort((a, b) => {
    const ka = composeFileSortKey(a);
    const kb = composeFileSortKey(b);
    return ka !== kb ? ka - kb : a.localeCompare(b);
  });
}

/** Prefer `compose.preview.yml` over generic `docker-compose.yml` when both exist. */
function composeFileSortKey(rel: string): number {
  const base = path.basename(rel);
  if (base === 'compose.preview.yml' || base === 'compose.preview.yaml') return 0;
  if (base === 'docker-compose.yml' || base === 'docker-compose.yaml') return 1;
  if (base === 'compose.yml' || base === 'compose.yaml') return 2;
  return 3;
}

export function discoverComposeFiles(workspaceDir: string): ComposeFileCandidate[] {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  const out: ComposeFileCandidate[] = [];
  for (const rel of listComposePaths(workspaceDir)) {
    const parsed = parseComposeFile(path.join(workspaceDir, rel), rel);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function inferMonorepo(workspaceDir: string, candidates: ComposeFileCandidate[]): boolean {
  if (candidates.length > 1) return true;
  const totalServices = candidates.reduce((n, c) => n + c.services.length, 0);
  if (totalServices > 2) return true;
  const appsDir = path.join(workspaceDir, 'apps');
  if (!existsSync(appsDir)) return false;
  try {
    const count = readdirSync(appsDir).filter((e) => {
      try {
        return statSync(path.join(appsDir, e)).isDirectory();
      } catch {
        return false;
      }
    }).length;
    return count >= 2;
  } catch {
    return false;
  }
}
