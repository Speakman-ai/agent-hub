/**
 * Compose-only detection for the Preview Setup wizard (Cursor parity).
 *
 * - Existing `docker-compose.yml` / `compose.yml` → confirm entry service, port, env.
 * - Missing compose → bootstrap proposal (write a starter file), never script mode.
 */
import { detectComposePreview } from './scaffolding/detect-compose-preview.js';
import {
  suggestComposeBootstrap,
  type ComposeBootstrapSuggestion,
} from './preview-compose-bootstrap.js';
import { scanEnvKeys } from './preview-setup-scans.js';

export type WizardPreviewPhase = 'confirm_compose' | 'bootstrap_compose';

export interface WizardComposeDetected {
  stack: 'compose';
  compose: {
    file: string;
    entryService: string | null;
    entryPort: number;
    services: string[];
    envFile?: string;
  };
  captureRoutes: string[];
  idleTTL: number;
}

export interface PreviewSetupDraft {
  phase: WizardPreviewPhase;
  /** Populated when `phase === "confirm_compose"`. */
  detected: WizardComposeDetected | null;
  /** Populated when `phase === "bootstrap_compose"`. */
  bootstrap: ComposeBootstrapSuggestion | null;
  envKeys: string[];
}

export function collectWizardPreviewDraft(workspaceDir: string): PreviewSetupDraft {
  const envKeys = scanEnvKeys(workspaceDir);

  let composeDetected: ReturnType<typeof detectComposePreview> = null;
  try {
    composeDetected = detectComposePreview(workspaceDir);
  } catch {
    composeDetected = null;
  }

  if (composeDetected) {
    return {
      phase: 'confirm_compose',
      detected: {
        stack: 'compose',
        compose: {
          file: composeDetected.compose.file,
          entryService: composeDetected.compose.entryService,
          entryPort: composeDetected.compose.entryPort,
          services: composeDetected.compose.services,
          ...(composeDetected.compose.envFile ? { envFile: composeDetected.compose.envFile } : {}),
        },
        captureRoutes: composeDetected.captureRoutes,
        idleTTL: composeDetected.idleTTL,
      },
      bootstrap: null,
      envKeys,
    };
  }

  return {
    phase: 'bootstrap_compose',
    detected: null,
    bootstrap: suggestComposeBootstrap(workspaceDir),
    envKeys,
  };
}
