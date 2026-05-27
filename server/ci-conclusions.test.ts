import { describe, it, expect } from 'vitest';
import {
  CI_FAIL_CONCLUSIONS,
  hasActionableCiFailure,
  latestCheckRunPerName,
} from './ci-conclusions.js';

describe('ci-conclusions', () => {
  it('does not treat cancelled as an actionable failure', () => {
    expect(CI_FAIL_CONCLUSIONS.has('cancelled')).toBe(false);
  });

  it('latestCheckRunPerName keeps the highest id per job name', () => {
    const latest = latestCheckRunPerName([
      { id: 10, name: 'CI', conclusion: 'failure' },
      { id: 20, name: 'CI', conclusion: 'success' },
      { id: 5, name: 'Tests (server 2/3)', conclusion: 'cancelled' },
      { id: 15, name: 'Tests (server 2/3)', conclusion: 'success' },
    ]);
    expect(latest).toEqual([
      { id: 20, name: 'CI', conclusion: 'success' },
      { id: 15, name: 'Tests (server 2/3)', conclusion: 'success' },
    ]);
  });

  it('hasActionableCiFailure is false when only superseded workflow runs failed', () => {
    const runs = [
      { id: 78124889311, name: 'Build & typecheck', conclusion: 'cancelled' },
      { id: 78124889462, name: 'Tests (server 2/3)', conclusion: 'cancelled' },
      { id: 78124974242, name: 'CI', conclusion: 'failure' },
      { id: 78124995485, name: 'Build & typecheck', conclusion: 'success' },
      { id: 78124995495, name: 'Tests (server 2/3)', conclusion: 'success' },
      { id: 78125764988, name: 'CI', conclusion: 'success' },
    ];
    expect(hasActionableCiFailure(runs)).toBe(false);
  });

  it('hasActionableCiFailure is true when the latest run per name still fails', () => {
    expect(
      hasActionableCiFailure([
        { id: 1, name: 'CI', conclusion: 'failure' },
        { id: 2, name: 'Tests (server 1/3)', conclusion: 'success' },
      ]),
    ).toBe(true);
  });
});
