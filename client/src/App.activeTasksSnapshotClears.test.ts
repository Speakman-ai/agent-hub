import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Regression guard: "Sessions kill processes but continue to wait".
 *
 * The `active-tasks-snapshot` handler used to restore streaming state from the
 * server snapshot but never clear it — there was no `else` branch. So a run
 * whose process was killed without a terminal frame reaching this client kept
 * the green "streaming" dot and the Interrupt badge up forever; even a
 * reconnect, which replays the snapshot proving the run is gone, could not
 * recover it.
 *
 * Both surfaces now delegate to `resolveStreamingFromSnapshot`
 * (`shared/utils/activeTaskSnapshot.ts`), which is authoritative in both
 * directions and behaviourally tested next to the helper. These are
 * source-level assertions because the handler lives in an inline switch inside
 * a very large render tree that is impractical to mount with live websocket
 * state.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, 'App.tsx'), 'utf8');
const mobileSource = readFileSync(
  join(here, '..', '..', 'mobile', 'src', 'context', 'AppContext.tsx'),
  'utf8',
);

const SURFACES: Array<[string, string]> = [
  ['web client', appSource],
  ['mobile client', mobileSource],
];

describe('active-tasks-snapshot streaming reconciliation', () => {
  for (const [name, source] of SURFACES) {
    it(`${name} imports the shared reconciler`, () => {
      expect(source).toMatch(
        /import \{ resolveStreamingFromSnapshot \} from '@shared\/utils\/activeTaskSnapshot'/,
      );
    });

    it(`${name} reconciles the snapshot instead of only restoring from it`, () => {
      const start = source.indexOf("case 'active-tasks-snapshot'");
      expect(start).toBeGreaterThan(-1);
      const branch = source.slice(start, source.indexOf('break;', start));
      expect(branch).toMatch(/resolveStreamingFromSnapshot\(next, activeSessionIdRef\.current\)/);
      // The set-only shape that caused the bug.
      expect(branch).not.toMatch(/if \(sid && next\[sid\]\)/);
    });
  }
});
