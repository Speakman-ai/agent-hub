# Continuous Session Replay — Datadog Parity (ADR)

> Status: spec locked (2026-06-23) · Type: epic decomposition · Author: agent-hub-dev
> Wiki mirror: `continuous-session-replay-datadog-parity`
> Decision input: full Datadog parity in capability, **off / opt-in per project** as the default posture.

## Problem

Agent Hub's session replay (`client/src/utils/sessionReplay.ts`) is **record-on-error
+ sampling**, not continuous. rrweb `record()` runs the whole session behind a
sample gate, but only a rolling 45s in-memory buffer (`DEFAULT_WINDOW_MS`, ≤5k
events) is kept, and nothing leaves the browser until an explicit flush on a
bug-report submit or an uncaught error. We capture the trailing window around an
*incident*, not the whole session.

Datadog Session Replay records the **entire** sampled-in session start-to-finish,
streams it to the backend in compressed **segments** continuously (web-worker
compression, ~<100 kB/min bandwidth), gates it behind a session-level **replay
sample rate**, and expires replays on a **30-day retention** TTL.
(Refs: Datadog [setup/config](https://docs.datadoghq.com/product_analytics/session_replay/browser/setup_and_configuration/),
[sampling best practices](https://docs.datadoghq.com/real_user_monitoring/guide/best-practices-for-rum-sampling/),
[retention filters](https://docs.datadoghq.com/real_user_monitoring/rum_without_limits/retention_filters/).)

## What we already have (≈70% of the transport)

- **Segmented streaming ingest** — `POST /api/replays/:id/events` (`server/routes/replays.ts`)
  is a chunked-append endpoint: first chunk carries the full snapshot, later
  chunks append incrementals. 16 MB/batch, 600 batches/hr. This is the continuous
  segment transport; the recorder just doesn't drive it yet.
- **A Datadog-Explorer-style dashboard** — `ReplaysDashboardPage.tsx` lists a
  project's replays with the rrweb player modal wired in.
- **Per-session sampling decision** — `sampledIn`, decided once per session.
- **mask-all privacy default** — already the default.

## The two gating problems

### 1. Storage is read-modify-write of a monolithic blob (quadratic)

`appendReplayEvents` (`server/replays/replay-store.ts`) implements a chunk append
as: **gunzip the entire prior blob → concat → re-gzip → overwrite the single
object**. For record-on-error (1–2 flushes) that's fine. For continuous capture a
30-minute session flushing every ~5s is ~360 appends, each re-reading and
re-writing the whole growing blob — total work is **O(n²)** in session length,
and the last append rewrites the full multi-MB session.

**Decision:** continuous parity requires a **segmented storage model** — each
flushed segment is its own immutable object keyed `replay-<id>/seg-<n>`, indexed
by a manifest (segment count + byte offsets + first/last ts), exactly like
Datadog's segments. Append becomes O(1) (write one new object + one manifest row
update). The paginated read API reads segments in order; the player concatenates
them. The existing monolithic path stays for record-on-error captures (back-compat),
selected by a `storage_layout` discriminator on the row.

### 2. Nothing expires — no TTL/GC

Today **no** retention exists: every captured replay accumulates forever. This is
already a latent storage leak for record-on-error captures, and a hard blocker for
"capture all sessions." A retention sweeper is a prerequisite, not a later nicety.

## Default posture

Full parity in **capability**, but **off / opt-in per project** by default —
unlike Datadog, which is sample-rate-driven on. Continuous capture stays disabled
until an operator opts a project in, because recording every screen of every user
is a privacy/policy decision, not just an engineering one. mask-all stays the
default and is enforced (not merely defaulted) when continuous capture is on.

## Decomposition (epic phases)

1. **Retention / TTL GC (foundational, shipped first).** `config.replayRetentionDays`
   (0 = off, the default). Background sweeper deletes **unlinked** expired replays;
   replays linked to a support ticket / kanban card are intentional triage
   artifacts and are never expired. Benefits the *existing* on-error system
   immediately (stops unbounded growth). → `server/replays/replay-retention-sweeper.ts`.
2. **Segmented blob storage model.** Per-segment objects + manifest; O(1) append;
   read/player concatenate segments. Back-compat with the monolithic layout via a
   `storage_layout` discriminator.
3. **Continuous recorder + web-worker flusher.** Periodic small-segment flush to
   `POST /api/replays/:id/events`; gzip in a Web Worker (off the UI thread);
   bounded offline outbox with retry/backpressure. Default **off**.
4. **Session-level replay sample rate, server-delivered & per-project.** Move the
   sample rate from client localStorage to per-project server config; deliver to the
   client; default off/low. Drives the continuous tier opt-in.
5. **Dashboard parity.** Continuous replays in `ReplaysDashboardPage` — full-session
   playback across segments, an in-progress/live indicator, filter continuous vs
   on-error.
6. **Per-project opt-in config + privacy guardrails.** Admin toggle (RUM settings),
   mask-all enforced when continuous is on, operator docs.

## Privacy caveat

Capturing all sessions sharply widens the privacy surface. mask-all helps but is
not sufficient as policy. Keep continuous off by default, behind explicit
per-project opt-in, and document the posture for operators.
