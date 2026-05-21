/**
 * Settings → Preview "Build and run" orchestration (single path).
 */
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import { buildPrEnvPatchFromWizardApply } from './preview-setup-apply.js';
import { runPreviewComposeBuildTest } from './preview-compose-build-test.js';
import {
  listRawPreviewSecretRows,
  parseDotEnv,
  replacePreviewSecretsMixed,
  PreviewSecretValidationError,
  type PreviewSecretInput,
} from './preview/preview-secrets-store.js';
import type { PreviewComposeRuntime } from './preview/preview-compose-runtime.js';
import type { Project } from './types.js';

const ALLOWED_COMPOSE_ROOT_FILES = new Set([
  'docker-compose.yml',
  'compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
]);

const COMPOSE_PATH_TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;

export interface PreviewBuildEnvVarInput {
  key: string;
  value?: string;
  kind?: 'plain' | 'secret';
}

export interface PreviewEnvironmentBuildBody {
  compose: {
    file?: string;
    entryService: string;
    entryPort: number;
    envFile?: string;
    healthPath?: string;
  };
  /** When bootstrapping, YAML to write before apply. */
  composeYaml?: string;
  captureRoutes?: string[];
  idleTTL?: number;
  envVars?: PreviewBuildEnvVarInput[];
}

export interface PreviewEnvironmentBuildResult {
  ok: boolean;
  steps: {
    composeWritten: boolean;
    configSaved: boolean;
    secretsSaved: number;
    previewTest: PreviewComposeBuildTestResult;
  };
  error?: string;
}

type PreviewComposeBuildTestResult = Awaited<ReturnType<typeof runPreviewComposeBuildTest>>;

function writeComposeFile(
  cwd: string,
  file: string,
  content: string,
): { ok: true } | { ok: false; error: string } {
  if (!ALLOWED_COMPOSE_ROOT_FILES.has(file)) {
    return {
      ok: false,
      error:
        'compose.file must be docker-compose.yml, compose.yml, docker-compose.yaml, or compose.yaml at project root',
    };
  }
  if (COMPOSE_PATH_TRAVERSAL_RE.test(file) || file.startsWith('/')) {
    return { ok: false, error: 'compose.file must be a relative root filename' };
  }
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: 'composeYaml must be non-empty' };
  const target = path.join(cwd, file);
  try {
    writeFileSync(target, trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to write compose file: ${message}` };
  }
}

export async function runPreviewEnvironmentBuild(deps: {
  project: Project;
  cwd: string;
  body: PreviewEnvironmentBuildBody;
  saveProjects: () => void;
  getPreviewComposeRuntime: () => PreviewComposeRuntime;
  actorUserId: string | null;
}): Promise<PreviewEnvironmentBuildResult | { ok: false; error: string; statusCode?: number }> {
  const { project, cwd, body, saveProjects, getPreviewComposeRuntime, actorUserId } = deps;
  const composeFile = (body.compose?.file || 'docker-compose.yml').trim();
  const entryService = (body.compose?.entryService || '').trim();
  if (!entryService) {
    return { ok: false, error: 'compose.entryService is required', statusCode: 400 };
  }
  const entryPort = Number(body.compose?.entryPort);
  if (!Number.isInteger(entryPort) || entryPort <= 0) {
    return { ok: false, error: 'compose.entryPort must be a positive integer', statusCode: 400 };
  }

  let composeWritten = false;
  const composePath = path.join(cwd, composeFile);
  if (!existsSync(composePath) && body.composeYaml) {
    const writeResult = writeComposeFile(cwd, composeFile, body.composeYaml);
    if (!writeResult.ok) return { ok: false, error: writeResult.error, statusCode: 400 };
    composeWritten = true;
  } else if (!existsSync(composePath)) {
    return {
      ok: false,
      error: `No compose file at ${composeFile} — provide composeYaml to generate one`,
      statusCode: 400,
    };
  }

  const healthPath = (body.compose?.healthPath || '/').trim() || '/';
  const envFile = (body.compose?.envFile || '').trim();
  const composeBlock: Record<string, unknown> = {
    file: composeFile,
    entryService,
    entryPort,
    healthPath,
  };
  if (envFile) composeBlock.envFile = envFile;

  const preview: Record<string, unknown> = {
    enabled: true,
    compose: composeBlock,
  };
  if (Array.isArray(body.captureRoutes) && body.captureRoutes.length > 0) {
    preview.captureRoutes = body.captureRoutes;
  }
  if (typeof body.idleTTL === 'number' && Number.isFinite(body.idleTTL)) {
    preview.idleTTL = body.idleTTL;
  }

  const prEnvResult = buildPrEnvPatchFromWizardApply(project, {
    enabled: true,
    preview,
  });
  if (!prEnvResult.ok) {
    return { ok: false, error: prEnvResult.error, statusCode: 400 };
  }
  (project as Record<string, unknown>).prEnv = prEnvResult.prEnv;
  saveProjects();

  let secretsSaved = 0;
  const envInputs = body.envVars || [];
  if (envInputs.length > 0) {
    try {
      const inputs: PreviewSecretInput[] = envInputs
        .filter((row) => row.key && row.key.trim())
        .map((row) => ({
          key: row.key.trim(),
          value: row.value ?? '',
          kind: row.kind === 'plain' ? 'plain' : 'secret',
        }));
      const existingRaw = listRawPreviewSecretRows(project.id);
      replacePreviewSecretsMixed(project.id, inputs, existingRaw, actorUserId);
      secretsSaved = inputs.length;
    } catch (err) {
      if (err instanceof PreviewSecretValidationError) {
        return { ok: false, error: err.message, statusCode: err.statusCode };
      }
      throw err;
    }
  }

  const runtime = getPreviewComposeRuntime();
  const previewTest = await runPreviewComposeBuildTest(runtime, project);

  const ok = previewTest.ok;
  return {
    ok,
    steps: {
      composeWritten,
      configSaved: true,
      secretsSaved,
      previewTest,
    },
    ...(ok ? {} : { error: previewTest.error }),
  };
}

/** Parse dotenv blob from import UI (optional). */
export function envVarsFromDotEnv(blob: string): PreviewBuildEnvVarInput[] {
  return parseDotEnv(blob).map((p) => ({
    key: p.key,
    value: p.value,
    kind: p.kind === 'plain' ? 'plain' : 'secret',
  }));
}
