---
name: code-walkthrough
description: >-
  Explain how an existing subsystem actually works — runtime flow, ownership,
  layering, and where a new thing should live — by tracing real code paths
  instead of guessing. Produces an onboarding-grade walkthrough: overview, key
  concepts, step-by-step flow, a file map with file:line anchors, and the
  gotchas. TRIGGER on "how does X work", "walk me through", "trace what happens
  when …", "where should this live", or reading unfamiliar code before changing
  it. DO NOT TRIGGER on "why was it built this way" (that is design intent — use
  design-rationale), on writing new code, or on trivial single-function
  questions answerable by reading one file.
category: workflow
version: 1.0.0
keep-coding-instructions: true
---

# Code Walkthrough — Explain How It Works

Answer "how does this work" from the code as it is, not from what the names
suggest it should be.

## Method

1. **Assess scope.** Single module, narrow question → explore and explain in
   one pass. Multi-file, cross-cutting subsystem → split into architectural
   slices first (data model, request path, config/state, side effects) and
   trace each before synthesizing.

2. **Trace, don't guess.** Follow the actual call path. When you assert a flow,
   you should be able to point at the `file:line` that proves it. If you are
   inferring, say so.

3. **Optional fan-out (engine-dependent).** If your engine supports parallel
   subagents (e.g. Claude Code's Task tool), assign one slice per explorer and
   reconcile their findings. If it does not, do the slices sequentially — the
   output is the same, only slower. Agent Hub itself does not dispatch
   subagents; this is the CLI engine's own capability.

## Present

- **Overview** — one paragraph: what the subsystem is for.
- **Key concepts** — the 3-6 nouns a reader must hold to follow the rest.
- **How it works** — the runtime flow, in order, with `file:line` anchors.
- **File map** — the files that matter and what each owns.
- **Gotchas** — the non-obvious constraints, invariants, and footguns.

Cite locations so the reader can verify and navigate, not just trust you.

---

_Provenance: adapted from concepts in Cursor's MIT-licensed `pstack` plugin
(`how`), trimmed to Agent Hub's flat, engine-agnostic agent model. Original
expression; ideas credited._
