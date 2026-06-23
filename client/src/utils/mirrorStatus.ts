/**
 * Pure mapping from the git-host mirror state (GET
 * /projects/:id/git-host/mirror → { enabled, refs, state }) to a banner
 * descriptor. Returns null when nothing needs surfacing (synced, or a
 * transient "ahead" the outbound mirror handles on its own).
 *
 * Kept pure + separate from the React component so it can be unit-tested
 * without rendering.
 */

function firstLine(s: any) {
  return String(s || '')
    .split('\n')
    .map((l: any) => l.trim())
    .filter(Boolean)[0];
}

export function describeMirrorState(mirror: any) {
  if (!mirror || !mirror.enabled) return null;
  const state = mirror.state || {};

  // Diverged and could not be auto-merged → needs a human.
  if (state.diverged || state.status === 'diverged') {
    const a = state.aheadBy ?? 0;
    const b = state.behindBy ?? 0;
    return {
      severity: 'error',
      title: 'Branches have diverged',
      detail:
        `The Hub and GitHub both have unique commits` +
        (a || b ? ` (Hub +${a}, GitHub +${b})` : '') +
        ` and could not be reconciled automatically. Resolve the conflict, then reconcile.`,
      showReconcile: true,
    };
  }

  // A recorded push error that hasn't been cleared by a later success.
  if (state.lastError && state.status !== 'synced') {
    return {
      severity: 'error',
      title: 'Mirror sync is failing',
      detail: firstLine(state.lastError) || 'The last push to GitHub was rejected.',
      showReconcile: true,
    };
  }

  // GitHub is ahead — commits landed directly on GitHub (e.g. a release
  // bot) that the Hub hasn't pulled yet. The poller normally pulls these;
  // surface it so a stuck one is visible and can be reconciled now.
  if (state.status === 'behind') {
    const b = state.behindBy ?? 0;
    return {
      severity: 'warn',
      title: 'GitHub is ahead of the Hub',
      detail: `${b || 'Some'} commit${b === 1 ? '' : 's'} on GitHub ${
        b === 1 ? 'is' : 'are'
      } not yet pulled into Agent Hub's git. Reconcile to pull them in.`,
      showReconcile: true,
    };
  }

  // synced / ahead (transient) / unknown → nothing to show.
  return null;
}
