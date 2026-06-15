---
name: rum-setup
description: >-
  Guided walkthrough for injecting the rrweb session-replay recorder into a
  target project. Triggered by POST .../rum/setup-wizard. Reads the
  server-precomputed detection draft (framework, injection target, CSP hits),
  writes the recorder init into the right entry file using the framework's
  injection style (module-init / client-component / script-tag), and extends
  any Content-Security-Policy with the ingest connect-src origin.
version: 1.0.0
keep-coding-instructions: true
---

# RUM Setup — Recorder Injection Walkthrough

You are a **worktree-backed** setup session: you already sit on a fresh
`agent-hub/…` branch, so make the edits, commit, and let Finalize Code
Changes push and open the PR. **Do not** create a new branch.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff.
- **`YOUR SESSION_ID`** — from kickoff.
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for any wizard curl. If
  a wizard curl returns HTTP **401** or **403**, halt and report the auth
  failure — never ask the operator to paste a token into chat.

## Draft (start here)

Kickoff embeds the full `draft` JSON from `collectRumSetupDraft()`. **Do not
re-run scanners** unless the user changed files mid-session.

| Field | Use |
|-------|-----|
| `framework` | Drives which injection recipe below applies |
| `plan.targetFile` | The file to inject the recorder init into |
| `plan.injectionStyle` | `module-init` \| `client-component` \| `script-tag` |
| `plan.recommendedConnectSrc` | Origin the recorder POSTs replays to — add to every CSP |
| `plan.alreadyInstrumented` | If `true`, stop and confirm before touching code |
| `cspHits[]` | Existing CSP locations (`meta` / `header`) to extend with the ingest origin |
| `entryCandidates[]` | Ranked injection candidates if you reject `plan.targetFile` |
| `typescript` | Pick `.ts(x)` vs `.js(x)` for any new file |

## Step 1 — Confirm the target

Summarize the detected framework, target file, and injection style in 2–3
sentences. If `plan.alreadyInstrumented` is `true` **or** `plan.targetFile`
is `null`, ask the user (fenced `agenthub:ask`) how to proceed before
editing — offer the ranked `entryCandidates` as options.

## Step 2 — Inject the recorder by injection style

Use `draft.plan.recommendedConnectSrc` as the ingest origin in the snippet.

**Masking policy (from kickoff):** the kickoff prompt's bound values include a
`maskAllText = <true|false>` flag — the operator's per-app masking choice. It selects
the whole policy; **`maskAllInputs` moves with it** (set both to the same value):

- `maskAllText: false` (default) → `{ maskAllInputs: false, maskAllText: false }` —
  mask password + PII fields only (the recorder always masks those); record other
  input values and visible text verbatim. Right for most third-party apps.
- `maskAllText: true` → `{ maskAllInputs: true, maskAllText: true }` — mask all
  inputs and all text; only structure/layout/timing is recorded. Use when the app
  surfaces secrets as text.

Use the exact value from the kickoff `maskAllText` for both flags; do not hardcode it.
Do **not** set `maskAllInputs: true` in the default mode — that would mask every input
and contradict the "record other content" policy the operator chose.

### `module-init` (SPA bootstrap, pages-router `_app`, Remix root)

Add an `import` + an init call near the top of the module so it runs in the
browser on load:

```ts
import { startRumRecorder } from '@agent-hub/rum'; // or the local recorder util
const strict = /* maskAllText from kickoff */ false;
startRumRecorder({
  ingestUrl: '<recommendedConnectSrc>/api/replays',
  maskAllInputs: strict, // passwords/PII are always masked regardless
  maskAllText: strict,
});
```

### `client-component` (Next.js app-router `app/layout.*` — a Server Component)

**Never** inline the recorder into the server layout. Create a sibling
`'use client'` component and start the recorder in `useEffect`, then render
it inside the layout body:

```tsx
'use client';
import { useEffect } from 'react';
export default function RumRecorder() {
  useEffect(() => {
    let stop: undefined | (() => void);
    const strict = /* maskAllText from kickoff */ false;
    import('@agent-hub/rum').then(({ startRumRecorder }) => {
      stop = startRumRecorder({
        ingestUrl: '<recommendedConnectSrc>/api/replays',
        maskAllInputs: strict, // passwords/PII are always masked regardless
        maskAllText: strict,
      });
    });
    return () => stop?.();
  }, []);
  return null;
}
```

### `script-tag` (served HTML document, `index.html`)

Add a `<script type="module">` to the document `<head>` that imports and
starts the recorder.

## Step 3 — Extend the Content-Security-Policy

For **every** entry in `draft.cspHits`, add `draft.plan.recommendedConnectSrc`
to the `connect-src` directive (create `connect-src` from `default-src` if it
is absent). `meta` hits live in the HTML `<meta http-equiv>`; `header` hits
live in config/source CSP strings. If `cspHits` is empty, note that no CSP was
found and the recorder's POST will not be blocked.

## Step 4 — Verify, commit, finish

- Type-check / build the target project if a script exists.
- Commit the recorder init + CSP edits to **this** session branch. Stop there —
  Finalize Code Changes pushes and opens the PR.
- Close the card:

```xml
<agenthub:close-card>
{"reason": "already-done", "note": "Recorder injected; CSP extended; committed for Finalize."}
</agenthub:close-card>
```

## Rules

- Stay on the session branch — never `git checkout -b`.
- **Fenced** `agenthub:ask` only (≥2 options). JSON uses `question`, `header`,
  `options[].label`, `options[].description` — not `prompt` / `id` / `type`.
- Do not push or open the PR yourself; that is Finalize's job.
