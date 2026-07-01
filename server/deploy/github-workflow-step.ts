/**
 * github-workflow-step.ts — declarative `github_workflow` deploy.yaml step.
 *
 * A deploy step normally runs a verbatim shell command (`run:`). This module
 * adds an alternative step shape that DISPATCHES a GitHub Actions workflow and
 * then POLLS the resulting run to completion, so a deploy that "kicks off a
 * GitHub Action" actually waits for that action to succeed or fail (instead of
 * returning the moment `gh workflow run` queues it) and surfaces the run's URL +
 * conclusion on the Deployments page.
 *
 * Wire format (inside a deploy.yaml environment's `steps:` list):
 *
 *   - name: Release
 *     github_workflow:
 *       workflow: release-all.yml        # filename or numeric id (required)
 *       ref: main                         # REQUIRED branch/tag (NOT a commit SHA)
 *       inputs:                           # optional workflow_dispatch inputs
 *         bump: patch
 *       poll_interval_seconds: 10         # optional (default 10, 5..300)
 *
 * `ref` is required and must be a branch or tag: GitHub `workflow_dispatch` only
 * accepts a branch/tag for its `ref` (a commit SHA is rejected), and a deploy's
 * ref is frequently a resolved SHA — so there is intentionally no deploy-ref
 * default.
 *
 * Design: the step is COMPILED to a `run` bash script at config-parse time (see
 * {@link compileGithubWorkflowRun}) and then executed through the exact same
 * RunnerBackend lease / timeout / output-tail machinery as any other step — the
 * `gh` CLI, the initiating user's GitHub token, and `GH_REPO` are already wired
 * into a deploy step's env by the orchestrator. The compiled script:
 *
 *   1. dispatches the workflow against the configured branch/tag
 *      (`gh workflow run --ref <ref>`),
 *   2. resolves the resulting run id (newest `workflow_dispatch` run on the ref
 *      that did NOT exist in a pre-dispatch id snapshot — clock-independent and
 *      version-robust, works on older `gh` too),
 *   3. watches it to completion (`gh run watch --exit-status`), so the step's
 *      exit code MIRRORS the workflow conclusion (fail-fast still applies), and
 *   4. prints a {@link GITHUB_RUN_MARKER} line carrying the run id / url /
 *      conclusion as compact JSON, which the orchestrator parses out of the
 *      step output tail and persists on the `deployment_steps` row.
 *
 * Everything here is PURE (config in → validated spec / bash string out, and
 * tail lines in → parsed result out) so it is trivially unit-testable without a
 * runner, a container, or the real `gh` CLI.
 */
import { DeployConfigError } from './deploy-config-error.js';

/** Parsed, validated `github_workflow:` step configuration. */
export interface GithubWorkflowStepSpec {
  /** Workflow filename (e.g. `release.yml`) or numeric id. Required. */
  workflow: string;
  /**
   * Branch or tag name to dispatch against. REQUIRED — GitHub `workflow_dispatch`
   * does not accept a commit SHA, and the deploy ref is often a resolved SHA, so
   * there is intentionally no deploy-ref default.
   */
  ref: string;
  /** `workflow_dispatch` inputs (string → string). */
  inputs?: Record<string, string>;
  /** Seconds between run-status polls (default 10, clamped 5..300). */
  pollIntervalSeconds?: number;
}

/** Marker prefix the compiled script prints so the orchestrator can recover run info. */
export const GITHUB_RUN_MARKER = '::agent-hub-github-run::';

export const GITHUB_WORKFLOW_POLL_DEFAULT_SECONDS = 10;
export const GITHUB_WORKFLOW_POLL_MIN_SECONDS = 5;
export const GITHUB_WORKFLOW_POLL_MAX_SECONDS = 300;

const SUPPORTED_GITHUB_WORKFLOW_KEYS = new Set([
  'workflow',
  'ref',
  'inputs',
  'poll_interval_seconds',
]);

/** Recovered GitHub Actions run info parsed from a {@link GITHUB_RUN_MARKER} line. */
export interface GithubRunResult {
  runId: string | null;
  url: string | null;
  status: string | null;
  conclusion: string | null;
  workflowName: string | null;
  displayTitle: string | null;
}

export interface GithubWorkflowResumeSpec {
  runId?: string | null;
  workflow?: string | null;
  ref?: string | null;
  createdAfter?: string | null;
  pollIntervalSeconds?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the raw `github_workflow:` mapping for a step. Throws
 * {@link DeployConfigError} with a stable `reason` on any malformed input.
 */
export function parseGithubWorkflowStepConfig(raw: unknown, where: string): GithubWorkflowStepSpec {
  if (!isPlainObject(raw)) {
    throw new DeployConfigError(
      'invalid_github_workflow',
      `${where}: "github_workflow" must be a mapping.`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!SUPPORTED_GITHUB_WORKFLOW_KEYS.has(key)) {
      throw new DeployConfigError(
        'unknown_key',
        `${where} github_workflow: unknown key "${key}". Allowed: ${[
          ...SUPPORTED_GITHUB_WORKFLOW_KEYS,
        ].join(', ')}.`,
      );
    }
  }

  const { workflow, ref, inputs } = raw;
  if (typeof workflow !== 'string' || workflow.trim() === '') {
    throw new DeployConfigError(
      'missing_workflow',
      `${where} github_workflow: "workflow" is required and must be a non-empty string.`,
    );
  }
  // `ref` is REQUIRED and must be a branch or tag name. GitHub's
  // `workflow_dispatch` only accepts a branch/tag for its `ref` — a commit SHA
  // is rejected with 422 "No ref found for: <sha>", and `gh run list --branch
  // <sha>` matches nothing. We deliberately do NOT default to the deploy ref:
  // production deploys run against a resolved commit SHA, so that default would
  // silently fail. The author must name the branch/tag to dispatch.
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new DeployConfigError(
      'missing_workflow_ref',
      `${where} github_workflow: "ref" is required and must be a branch or tag name ` +
        `(GitHub workflow_dispatch does not accept a commit SHA).`,
    );
  }

  let parsedInputs: Record<string, string> | undefined;
  if (inputs !== undefined) {
    if (!isPlainObject(inputs)) {
      throw new DeployConfigError(
        'invalid_workflow_inputs',
        `${where} github_workflow: "inputs" must be a mapping of string keys to scalar values.`,
      );
    }
    parsedInputs = {};
    for (const [key, value] of Object.entries(inputs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
        throw new DeployConfigError(
          'invalid_workflow_inputs',
          `${where} github_workflow: input key "${key}" must match [A-Za-z_][A-Za-z0-9_-]*.`,
        );
      }
      if (typeof value === 'string') parsedInputs[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') {
        parsedInputs[key] = String(value);
      } else {
        throw new DeployConfigError(
          'invalid_workflow_inputs',
          `${where} github_workflow: input "${key}" must be a string, number, or boolean.`,
        );
      }
    }
  }

  const pollRaw = raw['poll_interval_seconds'];
  let pollIntervalSeconds: number | undefined;
  if (pollRaw !== undefined) {
    if (typeof pollRaw !== 'number' || !Number.isFinite(pollRaw) || !Number.isInteger(pollRaw)) {
      throw new DeployConfigError(
        'invalid_workflow_poll',
        `${where} github_workflow: "poll_interval_seconds" must be an integer.`,
      );
    }
    if (pollRaw < GITHUB_WORKFLOW_POLL_MIN_SECONDS || pollRaw > GITHUB_WORKFLOW_POLL_MAX_SECONDS) {
      throw new DeployConfigError(
        'invalid_workflow_poll',
        `${where} github_workflow: "poll_interval_seconds" must be between ${GITHUB_WORKFLOW_POLL_MIN_SECONDS} and ${GITHUB_WORKFLOW_POLL_MAX_SECONDS}.`,
      );
    }
    pollIntervalSeconds = pollRaw;
  }

  return {
    workflow: workflow.trim(),
    ref: ref.trim(),
    ...(parsedInputs ? { inputs: parsedInputs } : {}),
    ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
  };
}

/** POSIX single-quote a value for safe interpolation into the generated bash. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compile a {@link GithubWorkflowStepSpec} into the `run` bash script the
 * orchestrator executes via `bash -euo pipefail -c <run>`. `spec.ref` is a
 * required branch/tag (the parser enforces it), so the dispatch ref is baked in
 * at compile time.
 */
export function compileGithubWorkflowRun(spec: GithubWorkflowStepSpec): string {
  const poll = spec.pollIntervalSeconds ?? GITHUB_WORKFLOW_POLL_DEFAULT_SECONDS;
  const workflowQ = shSingleQuote(spec.workflow);
  const refQ = shSingleQuote(spec.ref);
  const inputFlags = Object.entries(spec.inputs ?? {})
    .map(([key, value]) => ` -f ${shSingleQuote(`${key}=${value}`)}`)
    .join('');

  // Run-id resolution: snapshot the EXISTING run ids for this workflow+ref
  // BEFORE dispatch, then poll for a run id that was NOT in that set (newest
  // first). This is deliberately independent of any wall clock — comparing a
  // runner-local `date` against GitHub's `createdAt` is wrong under constant
  // clock skew (a lagging GitHub clock filters out the just-created run and the
  // step fails while the workflow actually ran). Diffing against a pre-dispatch
  // id snapshot removes that dependency AND the stale-prior-run ambiguity. It is
  // also tolerant of older `gh` — no reliance on `gh workflow run` printing the
  // URL (gh >= 2.87) or the dispatch API returning a run id (newer GitHub only).
  //
  // Concurrency assumption: same-(project,environment) deploys are serialized by
  // the environment lock, so the snapshot reliably isolates THIS deploy's run.
  // The only residual ambiguity is two deploys in DIFFERENT environments
  // dispatching the SAME workflow+branch within the poll window — then the
  // snapshot-diff can pick the sibling's run; "newest" is the best heuristic
  // available since `gh workflow run` does not return the run id it created.
  return [
    `set -euo pipefail`,
    `WORKFLOW=${workflowQ}`,
    `REF=${refQ}`,
    `POLL=${poll}`,
    // Snapshot pre-existing run ids (JSON array) so we can identify the new run.
    `PRE_RUN_IDS="$(gh run list --workflow "\${WORKFLOW}" --branch "\${REF}" --event workflow_dispatch \\`,
    `  --limit 100 --json databaseId --jq '[.[].databaseId]' 2>/dev/null || echo '[]')"`,
    `echo "Dispatching workflow \${WORKFLOW} on \${REF} ..."`,
    `gh workflow run "\${WORKFLOW}" --ref "\${REF}"${inputFlags}`,
    `RUN_ID=""`,
    `for _ in $(seq 1 30); do`,
    // Newest run id that did NOT exist before our dispatch.
    `  RUN_ID="$(gh run list --workflow "\${WORKFLOW}" --branch "\${REF}" --event workflow_dispatch \\`,
    `    --limit 100 --json databaseId,createdAt \\`,
    `    --jq "[.[] | select([.databaseId] | inside(\${PRE_RUN_IDS}) | not)] | sort_by(.createdAt) | last | .databaseId // empty" 2>/dev/null || true)"`,
    `  if [ -n "\${RUN_ID}" ]; then break; fi`,
    `  sleep 2`,
    `done`,
    `if [ -z "\${RUN_ID}" ]; then`,
    `  echo "github_workflow step: could not resolve a workflow run for \${WORKFLOW} on \${REF} after dispatch" >&2`,
    `  exit 1`,
    `fi`,
    `MARKER_JSON="$(gh run view "\${RUN_ID}" --json databaseId,url,status,conclusion,workflowName,displayTitle \\`,
    `  --jq '{runId:(.databaseId|tostring),url:.url,status:.status,conclusion:.conclusion,workflowName:.workflowName,displayTitle:.displayTitle}' 2>/dev/null || printf '{"runId":"%s","status":"queued"}' "\${RUN_ID}")"`,
    `echo "${GITHUB_RUN_MARKER}\${MARKER_JSON}"`,
    `echo "Watching workflow run \${RUN_ID} ..."`,
    `set +e`,
    `gh run watch "\${RUN_ID}" --interval "\${POLL}" --exit-status`,
    `WATCH_EXIT=$?`,
    `set -e`,
    `MARKER_JSON="$(gh run view "\${RUN_ID}" --json databaseId,url,status,conclusion,workflowName,displayTitle \\`,
    `  --jq '{runId:(.databaseId|tostring),url:.url,status:.status,conclusion:.conclusion,workflowName:.workflowName,displayTitle:.displayTitle}' 2>/dev/null || echo '{}')"`,
    `echo "${GITHUB_RUN_MARKER}\${MARKER_JSON}"`,
    `if [ "\${WATCH_EXIT}" -ne 0 ]; then`,
    `  echo "github_workflow step: run \${RUN_ID} did not succeed (exit \${WATCH_EXIT})" >&2`,
    `fi`,
    `exit "\${WATCH_EXIT}"`,
  ].join('\n');
}

/**
 * Compile a no-dispatch recovery script for a workflow step whose Hub poller was
 * interrupted. If a run id was already persisted, watch that run directly. For
 * legacy rows that predate early run-id persistence, rediscover the newest
 * matching workflow_dispatch run after the deployment was created, then watch it.
 */
export function compileGithubWorkflowResumeRun(spec: GithubWorkflowResumeSpec): string {
  const poll = spec.pollIntervalSeconds ?? GITHUB_WORKFLOW_POLL_DEFAULT_SECONDS;
  const runId = spec.runId?.trim();
  const workflow = spec.workflow?.trim();
  const ref = spec.ref?.trim();
  const createdAfter = spec.createdAfter?.trim();
  const lines = [`set -euo pipefail`, `POLL=${poll}`];

  if (runId) {
    lines.push(`RUN_ID=${shSingleQuote(runId)}`);
  } else {
    if (!workflow || !ref) {
      throw new Error('github_workflow recovery requires either runId or workflow/ref');
    }
    lines.push(
      `WORKFLOW=${shSingleQuote(workflow)}`,
      `REF=${shSingleQuote(ref)}`,
      `CREATED_AFTER=${shSingleQuote(createdAfter ?? '')}`,
      `export CREATED_AFTER`,
      `echo "Recovering workflow run \${WORKFLOW} on \${REF} ..."`,
      `RUN_ID="$(gh run list --workflow "\${WORKFLOW}" --branch "\${REF}" --event workflow_dispatch \\`,
      `  --limit 100 --json databaseId,createdAt \\`,
      `  --jq '[.[] | select(.createdAt >= env.CREATED_AFTER)] | sort_by(.createdAt) | last | .databaseId // empty' 2>/dev/null || true)"`,
      `if [ -z "\${RUN_ID}" ]; then`,
      `  echo "github_workflow recovery: could not find a workflow_dispatch run for \${WORKFLOW} on \${REF} after \${CREATED_AFTER}" >&2`,
      `  exit 1`,
      `fi`,
    );
  }

  lines.push(
    `MARKER_JSON="$(gh run view "\${RUN_ID}" --json databaseId,url,status,conclusion,workflowName,displayTitle \\`,
    `  --jq '{runId:(.databaseId|tostring),url:.url,status:.status,conclusion:.conclusion,workflowName:.workflowName,displayTitle:.displayTitle}' 2>/dev/null || printf '{"runId":"%s","status":"in_progress"}' "\${RUN_ID}")"`,
    `echo "${GITHUB_RUN_MARKER}\${MARKER_JSON}"`,
    `echo "Watching workflow run \${RUN_ID} ..."`,
    `set +e`,
    `gh run watch "\${RUN_ID}" --interval "\${POLL}" --exit-status`,
    `WATCH_EXIT=$?`,
    `set -e`,
    `MARKER_JSON="$(gh run view "\${RUN_ID}" --json databaseId,url,status,conclusion,workflowName,displayTitle \\`,
    `  --jq '{runId:(.databaseId|tostring),url:.url,status:.status,conclusion:.conclusion,workflowName:.workflowName,displayTitle:.displayTitle}' 2>/dev/null || echo '{}')"`,
    `echo "${GITHUB_RUN_MARKER}\${MARKER_JSON}"`,
    `if [ "\${WATCH_EXIT}" -ne 0 ]; then`,
    `  echo "github_workflow recovery: run \${RUN_ID} did not succeed (exit \${WATCH_EXIT})" >&2`,
    `fi`,
    `exit "\${WATCH_EXIT}"`,
  );
  return lines.join('\n');
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Recover GitHub Actions run info from a step's output tail by scanning for the
 * LAST {@link GITHUB_RUN_MARKER} line and JSON-parsing its payload. Returns null
 * when no well-formed marker is present (e.g. a plain `run:` step, or a
 * workflow step that failed before dispatch resolved a run).
 */
export function parseGithubRunMarker(tail: string[]): GithubRunResult | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    const idx = line.indexOf(GITHUB_RUN_MARKER);
    if (idx === -1) continue;
    const payload = line.slice(idx + GITHUB_RUN_MARKER.length).trim();
    if (!payload) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    return {
      runId: asNullableString(parsed.runId),
      url: asNullableString(parsed.url),
      status: asNullableString(parsed.status),
      conclusion: asNullableString(parsed.conclusion),
      workflowName: asNullableString(parsed.workflowName),
      displayTitle: asNullableString(parsed.displayTitle),
    };
  }
  return null;
}
