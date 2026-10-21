/**
 * Finalize dynamic test selection: the default full-run globs and the form
 * state helpers behind the `testSelection` project setting editors (web
 * CiRunsSection, mobile Runners screen). The server validates the PATCH in
 * `server/finalize/test-selection-policy.ts`, which reads its defaults from
 * here so every surface shows the same list.
 */

export type TestSelectionMode = 'full' | 'dynamic';

/**
 * Changes that can move any test's result without touching a test file:
 * dependency manifests and lockfiles, test-runner config, CI and container
 * definitions, and schema migrations. Project globs add to these.
 */
export const DEFAULT_FULL_RUN_PATHS: readonly string[] = [
  // JavaScript / TypeScript
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/bun.lock',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/vite.config.*',
  '**/jest.config.*',
  '**/playwright.config.*',
  '**/cypress.config.*',
  '**/tsconfig*.json',
  // Python
  '**/pyproject.toml',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile',
  '**/Pipfile.lock',
  '**/requirements*.txt',
  '**/setup.py',
  '**/setup.cfg',
  '**/pytest.ini',
  '**/tox.ini',
  '**/conftest.py',
  // Ruby
  '**/Gemfile',
  '**/Gemfile.lock',
  '**/*.gemspec',
  '**/.rspec',
  '**/spec/spec_helper.rb',
  '**/spec/rails_helper.rb',
  // Go
  '**/go.mod',
  '**/go.sum',
  // Rust
  '**/Cargo.toml',
  '**/Cargo.lock',
  // CI, containers, migrations (the migration globs match the base-drift hazard defaults)
  '.agent-hub/ci.yaml',
  '**/Dockerfile*',
  '**/docker-compose*.y*ml',
  '**/compose.y*ml',
  '**/migrations/**',
  '**/db/migrate/**',
];

export const DYNAMIC_NEEDS_CI_ON_PUSH_HINT =
  'Turn on CI on push first. Selected runs skip tests, so every merge to the default branch ' +
  'has to run the full suite to catch what they miss.';

export const CI_ON_PUSH_LOCKED_BY_DYNAMIC_HINT =
  'Dynamic test selection depends on CI on push. Switch selection back to full to turn it off.';

/** Stored project setting; every field optional, as in projects.json. */
export interface TestSelectionSettingsWire {
  mode?: string;
  alwaysRun?: string[];
  fullRunPaths?: string[];
}

export interface TestSelectionForm {
  mode: TestSelectionMode;
  alwaysRun: string[];
  /** The project's own globs, one per line. Defaults are shown separately. */
  fullRunPathsText: string;
}

function cleanList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * One glob per line, trimmed and deduped. Commas stay inside the line:
 * `fixtures/a,b/**` is a valid path pattern, not two globs.
 */
export function parseGlobList(text: string): string[] {
  return cleanList(text.split(/\r?\n/));
}

/** Unknown or missing mode reads as `full`, matching the server. */
export function testSelectionMode(settings: TestSelectionSettingsWire | null | undefined) {
  return settings?.mode === 'dynamic' ? 'dynamic' : 'full';
}

export function testSelectionFormFromSettings(
  settings: TestSelectionSettingsWire | null | undefined,
): TestSelectionForm {
  return {
    mode: testSelectionMode(settings),
    alwaysRun: cleanList(settings?.alwaysRun),
    fullRunPathsText: cleanList(settings?.fullRunPaths).join('\n'),
  };
}

/**
 * Identity of the stored list fields. Editors reset their draft only when
 * this changes, so saving the mode alone never discards unsaved list edits.
 */
export function testSelectionListsKey(settings: TestSelectionSettingsWire | null | undefined) {
  const { alwaysRun, fullRunPathsText } = testSelectionFormFromSettings(settings);
  return JSON.stringify({ alwaysRun, fullRunPathsText });
}

/** PATCH body for the list fields. Mode saves on its own toggle. */
export function testSelectionListsPatch(form: TestSelectionForm) {
  return {
    alwaysRun: cleanList(form.alwaysRun),
    fullRunPaths: parseGlobList(form.fullRunPathsText),
  };
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when the list fields differ from what is stored (order-insensitive for jobs). */
export function testSelectionListsDirty(
  form: TestSelectionForm,
  settings: TestSelectionSettingsWire | null | undefined,
): boolean {
  const stored = testSelectionFormFromSettings(settings);
  const next = testSelectionListsPatch(form);
  return (
    !sameList([...next.alwaysRun].sort(), [...stored.alwaysRun].sort()) ||
    !sameList(next.fullRunPaths, parseGlobList(stored.fullRunPathsText))
  );
}

export function toggleAlwaysRunJob(alwaysRun: string[], jobId: string): string[] {
  return alwaysRun.includes(jobId) ? alwaysRun.filter((id) => id !== jobId) : [...alwaysRun, jobId];
}

/**
 * Job ids to offer in the alwaysRun picker: every job configured in ci.yaml
 * (from the runner stats `tests` rows, one per job or matrix shard), plus any
 * stored id no longer configured so the user can still remove it.
 */
export function alwaysRunJobChoices(
  tests: ReadonlyArray<{ job_id?: unknown; configured?: unknown }> | null | undefined,
  alwaysRun: readonly string[],
): { id: string; configured: boolean }[] {
  const configured = new Set<string>();
  for (const t of tests ?? []) {
    if (t?.configured === true && typeof t.job_id === 'string' && t.job_id) {
      configured.add(t.job_id);
    }
  }
  const choices = [...configured].sort().map((id) => ({ id, configured: true }));
  for (const id of alwaysRun) {
    if (!configured.has(id)) choices.push({ id, configured: false });
  }
  return choices;
}

/**
 * Why the dynamic mode switch can't be flipped on, or null when it can.
 * Turning dynamic off is always allowed, even when CI on push is already
 * off (a hand-edited projects.json), so the user can get back to a valid state.
 */
export function dynamicModeBlockedReason(
  mode: TestSelectionMode,
  ciOnPushEnabled: boolean,
): string | null {
  if (mode === 'dynamic' || ciOnPushEnabled) return null;
  return DYNAMIC_NEEDS_CI_ON_PUSH_HINT;
}

/** Inline copy for a failed save: drops the `400: ` status prefix the API clients add. */
export function testSelectionSaveError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
  const text = raw.replace(/^\d{3}:\s*/, '').trim();
  return text || 'Failed to save test selection';
}
