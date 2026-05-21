/**
 * Unified preview detection for Settings → Preview and the setup wizard.
 *
 * Priority matches `POST /api/projects/:id/preview/detect`:
 *   1. Top-level docker-compose / compose.yml → compose mode
 *   2. Legacy `detectPreviewDefaults()` (script or multi-process)
 */
import { detectComposePreview } from './scaffolding/detect-compose-preview.js';
import { detectPreviewDefaults } from './scaffolding/detect-preview-defaults.js';
import type { PreviewProcess } from './types.js';

export type PreviewSetupMode = 'compose' | 'script' | 'multi-process';

export interface PreviewDetectSuggestionCompose {
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

export interface PreviewDetectSuggestionScript {
  stack: string;
  startScript: string;
  port: number;
  captureRoutes: string[];
  idleTTL: number;
}

export interface PreviewDetectSuggestionMultiProcess extends PreviewDetectSuggestionScript {
  processes: PreviewProcess[];
}

export type PreviewDetectSuggestion =
  | ({ mode: 'compose' } & PreviewDetectSuggestionCompose)
  | ({ mode: 'script' } & PreviewDetectSuggestionScript)
  | ({ mode: 'multi-process' } & PreviewDetectSuggestionMultiProcess);

/**
 * Inspect `workspaceDir` and return the best preview suggestion, or null
 * when nothing is detectable.
 */
export function detectPreviewSuggestion(workspaceDir: string): PreviewDetectSuggestion | null {
  if (!workspaceDir || typeof workspaceDir !== 'string') return null;

  let composeDetected: ReturnType<typeof detectComposePreview> = null;
  try {
    composeDetected = detectComposePreview(workspaceDir);
  } catch {
    composeDetected = null;
  }
  if (composeDetected) {
    return {
      mode: 'compose',
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
    };
  }

  let detected: ReturnType<typeof detectPreviewDefaults> = null;
  try {
    detected = detectPreviewDefaults(workspaceDir);
  } catch {
    detected = null;
  }
  if (!detected) return null;

  const base = {
    stack: detected.stack,
    startScript: detected.startScript,
    port: detected.port,
    captureRoutes: detected.captureRoutes,
    idleTTL: detected.idleTTL,
  };

  if (detected.processes && detected.processes.length > 0) {
    return { mode: 'multi-process', ...base, processes: detected.processes };
  }
  return { mode: 'script', ...base };
}

/** JSON shape returned by `POST .../preview/detect`. */
export function previewDetectSuggestionToJson(suggestion: PreviewDetectSuggestion | null): {
  detected: Record<string, unknown> | null;
} {
  if (!suggestion) return { detected: null };
  if (suggestion.mode === 'compose') {
    return {
      detected: {
        stack: suggestion.stack,
        compose: suggestion.compose,
        captureRoutes: suggestion.captureRoutes,
        idleTTL: suggestion.idleTTL,
      },
    };
  }
  const detected: Record<string, unknown> = {
    stack: suggestion.stack,
    startScript: suggestion.startScript,
    port: suggestion.port,
    captureRoutes: suggestion.captureRoutes,
    idleTTL: suggestion.idleTTL,
  };
  if (suggestion.mode === 'multi-process') {
    detected.processes = suggestion.processes;
  }
  return { detected };
}
