/**
 * Preview environment draft for Settings → Preview (compose-only, no agent wizard).
 */
import { detectComposePreview } from './scaffolding/detect-compose-preview.js';
import {
  discoverComposeFiles,
  inferMonorepo,
  type ComposeFileCandidate,
} from './preview-compose-discover.js';
import {
  suggestComposeBootstrap,
  type ComposeBootstrapSuggestion,
} from './preview-compose-bootstrap.js';
import { scanEnvKeys, scanPackageScriptCandidates } from './preview-setup-scans.js';
import {
  mergeEnvVarSuggestions,
  scanEnvExample,
  scanReadme,
  type EnvVarSuggestion,
  type ReadmeScanResult,
} from './preview-readme-scan.js';
import {
  buildComposePreviewChecklist,
  type ComposePreviewChecklistItem,
} from './preview-compose-checklist.js';

export type PreviewEnvironmentPhase = 'confirm_compose' | 'bootstrap_compose';

export interface PreviewEnvironmentCompose {
  file: string;
  entryService: string | null;
  entryPort: number;
  services: string[];
  envFile?: string;
  healthPath: string;
}

export interface PreviewEnvironmentDraft {
  phase: PreviewEnvironmentPhase;
  detected: {
    compose: PreviewEnvironmentCompose;
    captureRoutes: string[];
    idleTTL: number;
  } | null;
  bootstrap: ComposeBootstrapSuggestion | null;
  /** All compose files found (root + apps/*, etc.) — use for monorepo walkthrough. */
  composeCandidates: ComposeFileCandidate[];
  isMonorepo: boolean;
  readme: ReadmeScanResult;
  envExamplePath: string | null;
  envVars: EnvVarSuggestion[];
  /** Dev script hints for compose command tuning (display only). */
  scriptHints: Array<{ label: string; cwd: string }>;
  /** Compose preview contract — shown in Settings and embedded in the setup wizard prompt. */
  composeChecklist: ComposePreviewChecklistItem[];
}

export function collectPreviewEnvironmentDraft(workspaceDir: string): PreviewEnvironmentDraft {
  const readme = scanReadme(workspaceDir);
  const envExample = scanEnvExample(workspaceDir);
  const sourceKeys = scanEnvKeys(workspaceDir);
  const envVars = mergeEnvVarSuggestions(sourceKeys, readme, envExample);
  const scriptHints = scanPackageScriptCandidates(workspaceDir)
    .slice(0, 12)
    .map((s) => ({ label: s.label, cwd: s.cwd }));
  const composeCandidates = discoverComposeFiles(workspaceDir);
  const isMonorepo = inferMonorepo(workspaceDir, composeCandidates);

  let composeDetected: ReturnType<typeof detectComposePreview> = null;
  try {
    composeDetected = detectComposePreview(workspaceDir);
  } catch {
    composeDetected = null;
  }

  const primaryCandidate = composeCandidates[0] ?? null;

  if (composeDetected || primaryCandidate) {
    const file = composeDetected?.compose.file ?? primaryCandidate!.file;
    const services =
      composeDetected?.compose.services ?? primaryCandidate!.services.map((s) => s.name);
    const entryService =
      composeDetected?.compose.entryService ?? primaryCandidate!.suggestedEntryService;
    const entryPort = composeDetected?.compose.entryPort ?? primaryCandidate!.suggestedEntryPort;
    const healthPath = '/';
    const composeChecklist = buildComposePreviewChecklist({
      workspaceDir,
      composeFile: file,
      entryService,
      entryPort,
      healthPath,
    });
    return {
      phase: 'confirm_compose',
      detected: {
        compose: {
          file,
          entryService,
          entryPort,
          services,
          ...(composeDetected?.compose.envFile ? { envFile: composeDetected.compose.envFile } : {}),
          healthPath,
        },
        captureRoutes: composeDetected?.captureRoutes ?? ['/'],
        idleTTL: composeDetected?.idleTTL ?? 600,
      },
      bootstrap: null,
      composeCandidates,
      isMonorepo,
      readme,
      envExamplePath: envExample.envExamplePath,
      envVars,
      scriptHints,
      composeChecklist,
    };
  }

  const bootstrap = suggestComposeBootstrap(workspaceDir);
  const composeChecklist = buildComposePreviewChecklist({
    workspaceDir,
    composeFile: bootstrap.file,
    entryService: bootstrap.entryService,
    entryPort: bootstrap.entryPort,
    healthPath: '/',
  });
  return {
    phase: 'bootstrap_compose',
    detected: null,
    bootstrap,
    composeCandidates,
    isMonorepo,
    readme,
    envExamplePath: envExample.envExamplePath,
    envVars,
    scriptHints,
    composeChecklist,
  };
}
