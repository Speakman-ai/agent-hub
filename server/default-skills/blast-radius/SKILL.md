---
name: blast-radius
description: >-
  Assess the full impact of a code change before trusting it — what else could
  break, not just what you touched. Enumerate every affected symbol and its
  downstream callers, isolate the single safety assumption the change rests on,
  search past what grep finds (lockfiles and version pins, async/timing order,
  serialized shapes, DB columns, feature flags, env), grade risks honestly, and
  prove the risky ones with a script that fails loudly. TRIGGER on "what could
  this break", "is this change safe", reviewing an unfamiliar or large diff,
  touching shared/core code, dependency bumps, or changes to serialization,
  migrations, or public API shapes. DO NOT TRIGGER on trivial, isolated,
  well-tested local edits, or pure formatting/comment changes.
category: workflow
version: 1.0.0
keep-coding-instructions: true
---

# Blast Radius — Change Impact Analysis

Before you trust a change, map what it can reach. The goal is not a
reassuring writeup; it is evidence.

## Method

1. **Enumerate the surface.** From the diff, list every symbol added, removed,
   or behaviorally changed. For each, find who depends on it — direct callers
   and non-obvious downstream effects (overrides, event handlers, serialized
   consumers).

2. **Find the linchpin.** Most changes that look risky are safe because of one
   underlying fact (a call is always synchronous, an input is always
   validated upstream, a column is never null). Name that assumption
   explicitly. Most of your effort belongs on confirming or breaking it, not on
   tangential worries.

3. **Search past grep.** A symbol search misses the dangerous cases:
   - **Version pins / lockfiles** — is the behavior you rely on the pinned
     version's behavior?
   - **Timing and ordering** — microtasks, `await` points, event loops,
     retries, debounces.
   - **Indirect contracts** — API response shapes, DB columns, feature flags,
     env vars, cached/serialized data, cross-service payloads.
   - **Library internals** — read the dependency source when your assumption
     lives inside it.

4. **Grade honestly.** Split findings into **confirmed risks** and
   **investigated-and-cleared**. For each risk give a realistic
   probability × impact and a specific `file:line`. Do not pad the list to look
   thorough; do not hide a real risk to look done.

5. **Prove it.** For each material risk, write and run a check that exercises
   the real code/library and **fails loudly** if the assumption is wrong — a
   unit test, a script, a repro. In this repo that means a Vitest test
   (never one that spawns a real CLI or hits a live deployment; see the test
   rails in `CLAUDE.md`).

## Core principle

A writeup that sounds right is worthless without a run. Prose is where you
form the hypothesis; a passing (or failing) check is the deliverable. If you
cannot prove it, say so and mark the risk unverified.

---

_Provenance: adapted from concepts in Cursor's MIT-licensed `pstack` plugin
(`blast-radius`). Original expression; ideas credited._
