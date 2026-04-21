import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { describe, it, expect } from 'vitest';

// Regression guard for the "don't toast on archive" UX decision.
// Rationale: the sidebar's Archived section already surfaces the row with
// a "purges in Nh" countdown, which doubles as the user-visible feedback.
// A redundant toast was removed — this test prevents accidental re-introduction.
const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, 'App.jsx'), 'utf8');

describe('handleDeleteSession — no success toast', () => {
  it('does not emit a success toast when archiving a session', () => {
    // Isolate the body of handleDeleteSession so we only fail on real
    // regressions inside that handler, not on unrelated toast strings
    // that happen to appear elsewhere in App.jsx.
    const startIdx = appSource.indexOf('const handleDeleteSession = async');
    expect(startIdx).toBeGreaterThan(-1);
    const afterStart = appSource.slice(startIdx);
    const bodyEnd = afterStart.indexOf('\n  };');
    expect(bodyEnd).toBeGreaterThan(-1);
    const handlerBody = afterStart.slice(0, bodyEnd);

    // The removed toast text — must not reappear.
    expect(handlerBody).not.toContain('restore from Archived within 7 days');

    // The only showToast call left in the handler should live inside
    // the catch block (archive failures). We assert exactly one call.
    const toastCalls = handlerBody.match(/showToast\(/g) || [];
    expect(toastCalls.length).toBe(1);

    // And that surviving call must reference the failure-path string.
    expect(handlerBody).toMatch(/Archive failed:/);
  });
});
