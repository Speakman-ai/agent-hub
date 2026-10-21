/**
 * Duration bound on a single stored replay.
 *
 * The web client rotates its continuous capture to a fresh replay id every
 * `REPLAY_MAX_CHUNK_MS`, but third-party recorders injected by the RUM wizard
 * don't have to, and a tab left open overnight kept appending to one id for
 * 19+ hours (one snapshot, then hours-long idle gaps). The event and byte caps
 * never fire on that shape, so ingest enforces the span directly.
 *
 * Keep in step with `REPLAY_MAX_CHUNK_MS` in `client/src/utils/sessionReplay.ts`.
 */
import type { ReplayEvent } from './replay-store.js';

export const REPLAY_MAX_DURATION_MS = (() => {
  const raw = Number(process.env.REPLAY_MAX_DURATION_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15 * 60 * 1000;
})();

const RRWEB_FULL_SNAPSHOT = 2;
const RRWEB_META = 4;

/**
 * Drop leading events so the capture starts at the earliest checkout (rrweb Meta
 * + FullSnapshot) that lies within `capMs` of the last event. A replay must open
 * on a full snapshot to be reconstructable, so the cut can only land on one.
 * When no checkout is that recent, the latest checkout is used; with no checkout
 * at all the events are returned unchanged. Pure.
 */
export function trimToRecentCheckout(events: ReplayEvent[], capMs: number): ReplayEvent[] {
  if (events.length === 0) return events;
  const last = events[events.length - 1].timestamp;
  let latest = -1;
  let chosen = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].type !== RRWEB_FULL_SNAPSHOT) continue;
    latest = i;
    if (chosen === -1 && last - events[i].timestamp <= capMs) chosen = i;
  }
  const start = chosen !== -1 ? chosen : latest;
  if (start <= 0) return events;
  const from = events[start - 1].type === RRWEB_META ? start - 1 : start;
  return from === 0 ? events : events.slice(from);
}

/**
 * Split an append batch at the replay's duration bound: the longest prefix whose
 * timestamps stay within `firstTimestamp + capMs` is accepted, and `overflow`
 * reports whether anything was cut. A prefix (not a filter) so stored events
 * stay in arrival order. Pure.
 */
export function splitAtDurationCap(
  firstTimestamp: number,
  events: ReplayEvent[],
  capMs: number,
): { accepted: ReplayEvent[]; overflow: boolean } {
  const limit = firstTimestamp + capMs;
  let i = 0;
  while (i < events.length && events[i].timestamp <= limit) i += 1;
  return {
    accepted: i === events.length ? events : events.slice(0, i),
    overflow: i < events.length,
  };
}

/**
 * Bound a whole capture (a one-shot upload or a replay's creating chunk) to
 * `capMs`: open on the most recent usable checkout, then cut every event past
 * `start + capMs`. The second step is what enforces the bound when the only
 * snapshot is old (an idle tab's page-load checkout followed by hours of gap):
 * the head stays replayable and the stale tail is dropped. Pure.
 */
export function capCapture(
  events: ReplayEvent[],
  capMs: number,
): { events: ReplayEvent[]; overflow: boolean } {
  const trimmed = trimToRecentCheckout(events, capMs);
  if (trimmed.length === 0) return { events: trimmed, overflow: false };
  const { accepted, overflow } = splitAtDurationCap(trimmed[0].timestamp, trimmed, capMs);
  return { events: accepted, overflow };
}
