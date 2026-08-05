/**
 * Durable first-run onboarding gate.
 *
 * Creating the Owner via `/api/auth/setup` is only step 1 of SetupWizard
 * (account → welcome → engines → github → first project). Password managers
 * (Bitwarden generate, autofill) can interrupt mid-wizard after auth.json
 * exists — without this flag the client treated `authConfigured: true` as
 * "setup done" and dropped the user into the main chrome (often stuck on
 * WebSocket "Reconnecting…" if the rest of init never finished).
 *
 * Stored in `<dataDir>/config.json` as `onboardingComplete`.
 *
 * Semantics:
 *   - missing + authConfigured → true (legacy installs that finished before
 *     this flag existed must not be forced back through the wizard)
 *   - missing + !authConfigured → false (true fresh install)
 *   - explicit false → resume SetupWizard
 *   - explicit true → skip SetupWizard
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import config from './config.js';
import { isAuthConfigured } from './auth-store.js';

const FLAG_KEY = 'onboardingComplete';

type ConfigFile = Record<string, unknown>;

function configPath(dataDir: string = config.dataDir): string {
  return path.join(dataDir, 'config.json');
}

function readConfigFile(dataDir: string = config.dataDir): ConfigFile {
  const filePath = configPath(dataDir);
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ConfigFile) : {};
  } catch {
    return {};
  }
}

function writeConfigFile(fileConfig: ConfigFile, dataDir: string = config.dataDir): void {
  const filePath = configPath(dataDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(fileConfig, null, 2) + '\n');
}

/**
 * Whether the interactive SetupWizard has finished. Used by
 * `GET /api/setup/status` so the client can resume after an interrupted
 * first-run (password-manager kickout, reload mid-wizard, etc.).
 */
export function isOnboardingComplete(dataDir: string = config.dataDir): boolean {
  const fileConfig = readConfigFile(dataDir);
  if (typeof fileConfig[FLAG_KEY] === 'boolean') {
    return fileConfig[FLAG_KEY] as boolean;
  }
  // Legacy: Owner already existed before this flag shipped → treat as done.
  try {
    return isAuthConfigured();
  } catch {
    return false;
  }
}

/** Mark onboarding unfinished (called when Owner account is created). */
export function markOnboardingIncomplete(dataDir: string = config.dataDir): void {
  const fileConfig = readConfigFile(dataDir);
  fileConfig[FLAG_KEY] = false;
  writeConfigFile(fileConfig, dataDir);
}

/** Mark onboarding finished (called when SetupWizard completes). */
export function markOnboardingComplete(dataDir: string = config.dataDir): void {
  const fileConfig = readConfigFile(dataDir);
  fileConfig[FLAG_KEY] = true;
  writeConfigFile(fileConfig, dataDir);
}
