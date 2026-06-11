/**
 * Adaptive Questionnaire — state model and pure helpers.
 *
 * Drives the "What are you building?" wizard that scaffolds a brand-new
 * project. The first step is required (no idk); every later step exposes an
 * "idk" escape hatch that records "defer to agent/default" semantics so the
 * provisioning job can fall back to opinionated defaults without losing the
 * user's intent.
 */

/** Sentinel value stored in the draft when the user picks "idk". */
export const IDK = 'idk';

/** Ordered step identifiers — used for both progress strip + navigation. */
export const STEP_IDS = [
  'description',
  'appType',
  'stack',
  'integrations',
  'auth',
  'hosting',
  'identity',
  'review',
];

/** Human labels for the journey strip / step indicator. */
export const STEP_LABELS = {
  description: 'What',
  appType: 'Type',
  stack: 'Stack',
  integrations: 'Integrations',
  auth: 'Auth',
  hosting: 'Hosting',
  identity: 'Name',
  review: 'Review',
};

/** App type options offered in step 2. */
export const APP_TYPE_OPTIONS = [
  {
    value: 'web-app',
    label: 'Web app',
    description: 'Browser-based app (React/Vue/Svelte UI + backend)',
  },
  { value: 'api', label: 'API / Backend service', description: 'REST or GraphQL service, no UI' },
  { value: 'cli', label: 'CLI tool', description: 'Command-line utility' },
  {
    value: 'mobile',
    label: 'Mobile app',
    description: 'iOS / Android (React Native, Expo, Swift, Kotlin)',
  },
  { value: 'desktop', label: 'Desktop app', description: 'Electron or native desktop' },
  { value: 'ml', label: 'ML / Data pipeline', description: 'Training, inference, ETL' },
  {
    value: 'library',
    label: 'Library / SDK',
    description: 'Reusable package, published to a registry',
  },
];

/** Integration multi-select options for step 4. */
export const INTEGRATION_OPTIONS = [
  { value: 'github', label: 'GitHub', description: 'Source control, PRs, issues' },
  { value: 'aws', label: 'AWS', description: 'Compute, storage, managed services' },
  { value: 'auth', label: 'Auth', description: 'User authentication & sessions' },
  { value: 'db', label: 'Database', description: 'Persistent storage (SQL, NoSQL)' },
  {
    value: 'kanban',
    label: 'Kanban / Issue tracker',
    description: 'Linear, Jira, or Agent Hub board',
  },
  { value: 'slack', label: 'Slack', description: 'Notifications & bots' },
  { value: 'stripe', label: 'Payments', description: 'Stripe or similar' },
  { value: 'analytics', label: 'Analytics', description: 'Product or marketing analytics' },
];

/** Auth-provider options surfaced when the user selects the Auth integration. */
export const AUTH_PROVIDER_OPTIONS = [
  {
    value: 'email-password',
    label: 'Email + password',
    description: 'Self-hosted with password hashing',
  },
  { value: 'magic-link', label: 'Magic link', description: 'Email-based passwordless' },
  { value: 'oauth', label: 'OAuth / social', description: 'Google, GitHub, etc.' },
  { value: 'saml', label: 'SAML / SSO', description: 'Enterprise single sign-on' },
  { value: 'clerk', label: 'Clerk / Auth0 / WorkOS', description: 'Managed auth provider' },
];

/** Optional per-app-type stack recommendations. `stack` in step 3 defaults
 *  to the first entry. Users may edit freely or pick "idk". */
/** Hosting options (step: hosting). Agent Hub is the recommended default. */
export const HOSTING_OPTIONS = [
  {
    value: 'agenthub',
    label: 'Agent Hub (recommended)',
    blurb:
      'Repo lives in Agent Hub — native PRs, CI, branch protection out of the box. GitHub can mirror or be linked later.',
  },
  {
    value: 'github',
    label: 'GitHub only',
    blurb: 'Classic setup: the repo lives on GitHub and Agent Hub talks to it via the GitHub API.',
  },
];

export const STACK_RECOMMENDATIONS = {
  'web-app': [
    {
      value: 'react-vite-express-sqlite',
      label: 'React + Vite + Express + SQLite',
      recommended: true,
    },
    { value: 'next-postgres', label: 'Next.js + Postgres' },
    { value: 'sveltekit-postgres', label: 'SvelteKit + Postgres' },
    { value: 'remix-postgres', label: 'Remix + Postgres' },
  ],
  api: [
    { value: 'express-ts-sqlite', label: 'Express + TypeScript + SQLite', recommended: true },
    { value: 'fastapi-postgres', label: 'FastAPI + Postgres' },
    { value: 'go-chi-postgres', label: 'Go (chi) + Postgres' },
    { value: 'rails-postgres', label: 'Rails + Postgres' },
  ],
  cli: [
    { value: 'node-ts-commander', label: 'Node + TypeScript + commander', recommended: true },
    { value: 'go-cobra', label: 'Go + cobra' },
    { value: 'python-click', label: 'Python + click' },
    { value: 'rust-clap', label: 'Rust + clap' },
  ],
  mobile: [
    { value: 'expo-rn', label: 'Expo + React Native', recommended: true },
    { value: 'swift-swiftui', label: 'Swift + SwiftUI (iOS only)' },
    { value: 'kotlin-compose', label: 'Kotlin + Jetpack Compose (Android only)' },
    { value: 'flutter', label: 'Flutter' },
  ],
  desktop: [
    { value: 'electron-react', label: 'Electron + React', recommended: true },
    { value: 'tauri-react', label: 'Tauri + React' },
    { value: 'swift-appkit', label: 'Swift + AppKit (macOS only)' },
  ],
  ml: [
    { value: 'python-pytorch', label: 'Python + PyTorch', recommended: true },
    { value: 'python-sklearn', label: 'Python + scikit-learn' },
    { value: 'python-jax', label: 'Python + JAX' },
  ],
  library: [
    { value: 'ts-tsup-vitest', label: 'TypeScript + tsup + Vitest', recommended: true },
    { value: 'python-poetry', label: 'Python + Poetry + pytest' },
    { value: 'go-module', label: 'Go module' },
  ],
};

/** Returns the recommended stack value for a given app type, or null. */
export function recommendedStack(appType) {
  const list = STACK_RECOMMENDATIONS[appType];
  if (!Array.isArray(list)) return null;
  const rec = list.find((s) => s.recommended);
  return rec ? rec.value : list[0]?.value || null;
}

/** Returns the full ordered option list for a given app type, or []. */
export function stackOptionsFor(appType) {
  return STACK_RECOMMENDATIONS[appType] || [];
}

/** Fresh draft state. `step` is always an index into STEP_IDS. */
export function initialDraft() {
  return {
    v: 1,
    step: 0,
    description: '',
    appType: null,
    stack: null,
    integrations: null,
    authDetail: null,
    hosting: null,
    name: '',
    generationModel: null,
    visibility: null,
  };
}

/**
 * Step 1 requires a non-empty trimmed description. No idk is allowed here.
 * Validation blocks Continue until this returns true.
 */
export function isDescriptionValid(description) {
  return typeof description === 'string' && description.trim().length > 0;
}

/** True if a value represents the "idk / defer to agent" escape hatch. */
export function isIdk(value) {
  if (value === IDK) return true;
  if (Array.isArray(value)) return false;
  if (value && typeof value === 'object') {
    return Object.values(value).every((v) => v === IDK);
  }
  return false;
}

/**
 * Returns true when the `auth` step should be shown for the given integration
 * selection. The step is skipped when:
 *  - integrations is idk (defer everything to the agent)
 *  - integrations is an explicit array that does not include 'auth'
 */
export function shouldShowAuthStep(integrations) {
  if (integrations === IDK) return false;
  if (!Array.isArray(integrations)) return false;
  return integrations.includes('auth');
}

/**
 * Returns the ordered list of step IDs that are *actually* shown for a given
 * draft. The auth step is conditionally skipped.
 */
export function visibleSteps(draft) {
  return STEP_IDS.filter((id) => {
    if (id === 'auth') return shouldShowAuthStep(draft.integrations);
    return true;
  });
}

/** Compute the (0-based) visible step index from the raw draft.step pointer. */
export function currentVisibleStep(draft) {
  const visible = visibleSteps(draft);
  const id = STEP_IDS[draft.step] ?? STEP_IDS[0];
  const idx = visible.indexOf(id);
  return idx === -1 ? 0 : idx;
}

/**
 * Can the user advance from the current step? Step 1 requires a valid
 * description; every other step may advance either with a concrete answer or
 * the idk sentinel.
 */
export function canContinue(draft) {
  const stepId = STEP_IDS[draft.step];
  switch (stepId) {
    case 'description':
      return isDescriptionValid(draft.description);
    case 'appType':
      return draft.appType !== null;
    case 'stack':
      return draft.stack !== null;
    case 'integrations':
      return (
        draft.integrations === IDK ||
        (Array.isArray(draft.integrations) && draft.integrations.length > 0)
      );
    case 'auth':
      return draft.authDetail !== null;
    case 'hosting':
      return draft.hosting !== null;
    case 'identity':
      return (
        (draft.name === IDK || (typeof draft.name === 'string' && draft.name.trim().length > 0)) &&
        draft.visibility !== null
      );
    case 'review':
      return true;
    default:
      return false;
  }
}

/**
 * Advance to the next step in the visible sequence. No-op on the final step.
 */
export function advance(draft) {
  const visible = visibleSteps(draft);
  const currentIdx = currentVisibleStep(draft);
  const nextId = visible[currentIdx + 1];
  if (!nextId) return draft;
  return { ...draft, step: STEP_IDS.indexOf(nextId) };
}

/** Back up one step in the visible sequence. No-op on step 0. */
export function goBack(draft) {
  const visible = visibleSteps(draft);
  const currentIdx = currentVisibleStep(draft);
  const prevId = visible[currentIdx - 1];
  if (!prevId) return draft;
  return { ...draft, step: STEP_IDS.indexOf(prevId) };
}

/** Serialize the draft for the provisioning job. */
export function toProvisioningPayload(draft) {
  return {
    version: 1,
    description: draft.description.trim(),
    appType: draft.appType,
    stack: draft.stack,
    integrations: draft.integrations,
    authDetail: draft.authDetail,
    name: draft.name === IDK ? IDK : String(draft.name || '').trim(),
    visibility: draft.visibility,
    // idk → Hub hosting (the recommended default).
    hostOnAgentHub: draft.hosting !== 'github',
    generationModel: draft.generationModel || null,
  };
}

/** Key under which the draft is persisted in sessionStorage. */
export const ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY = 'agentHub:v1:adaptiveQuestionnaireDraft';
