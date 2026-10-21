import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_NEEDS_CI_ON_PUSH_HINT,
  alwaysRunJobChoices,
  dynamicModeBlockedReason,
  parseGlobList,
  testSelectionFormFromSettings,
  testSelectionListsDirty,
  testSelectionListsKey,
  testSelectionListsPatch,
  testSelectionSaveError,
  toggleAlwaysRunJob,
} from './testSelection';

describe('testSelectionFormFromSettings', () => {
  it('defaults to full with empty lists', () => {
    expect(testSelectionFormFromSettings(undefined)).toEqual({
      mode: 'full',
      alwaysRun: [],
      fullRunPathsText: '',
    });
  });

  it('reads an unknown mode as full and cleans the lists', () => {
    const form = testSelectionFormFromSettings({
      mode: 'smart',
      alwaysRun: ['lint', ' lint ', '', 'build'],
      fullRunPaths: ['proto/**', 'schema/*.sql'],
    });
    expect(form).toEqual({
      mode: 'full',
      alwaysRun: ['lint', 'build'],
      fullRunPathsText: 'proto/**\nschema/*.sql',
    });
    expect(testSelectionFormFromSettings({ mode: 'dynamic' }).mode).toBe('dynamic');
  });
});

describe('parseGlobList / testSelectionListsPatch', () => {
  it('splits on newlines only, trims, and dedupes', () => {
    expect(parseGlobList(' proto/** \r\n\nschema/*.sql\nproto/**\n')).toEqual([
      'proto/**',
      'schema/*.sql',
    ]);
  });

  it('keeps commas inside a glob', () => {
    expect(parseGlobList('fixtures/a,b/**\n{src,lib}/**/*.sql')).toEqual([
      'fixtures/a,b/**',
      '{src,lib}/**/*.sql',
    ]);
  });

  it('builds the list PATCH body without the mode', () => {
    expect(
      testSelectionListsPatch({
        mode: 'dynamic',
        alwaysRun: ['lint', 'lint'],
        fullRunPathsText: 'a/**\n',
      }),
    ).toEqual({ alwaysRun: ['lint'], fullRunPaths: ['a/**'] });
  });
});

describe('testSelectionListsDirty', () => {
  const stored = { mode: 'dynamic', alwaysRun: ['lint', 'build'], fullRunPaths: ['a/**'] };

  it('is clean for the stored value, job order, and whitespace edits', () => {
    const form = testSelectionFormFromSettings(stored);
    expect(testSelectionListsDirty(form, stored)).toBe(false);
    expect(
      testSelectionListsDirty(
        { ...form, alwaysRun: ['build', 'lint'], fullRunPathsText: ' a/** \n' },
        stored,
      ),
    ).toBe(false);
  });

  it('is dirty when a job or glob changes', () => {
    const form = testSelectionFormFromSettings(stored);
    expect(testSelectionListsDirty({ ...form, alwaysRun: ['lint'] }, stored)).toBe(true);
    expect(testSelectionListsDirty({ ...form, fullRunPathsText: 'a/**\nb/**' }, stored)).toBe(true);
  });
});

describe('testSelectionListsKey', () => {
  it('ignores the mode and changes with the lists', () => {
    const lists = { alwaysRun: ['lint'], fullRunPaths: ['a/**'] };
    expect(testSelectionListsKey({ ...lists, mode: 'full' })).toBe(
      testSelectionListsKey({ ...lists, mode: 'dynamic' }),
    );
    expect(testSelectionListsKey(lists)).not.toBe(
      testSelectionListsKey({ ...lists, alwaysRun: [] }),
    );
  });
});

describe('toggleAlwaysRunJob', () => {
  it('adds and removes a job id', () => {
    expect(toggleAlwaysRunJob(['lint'], 'build')).toEqual(['lint', 'build']);
    expect(toggleAlwaysRunJob(['lint', 'build'], 'lint')).toEqual(['build']);
  });
});

describe('alwaysRunJobChoices', () => {
  it('lists each configured job once, sorted, then stored ids no longer configured', () => {
    const tests = [
      { job_id: 'server-tests', matrix_key: '1', configured: true },
      { job_id: 'server-tests', matrix_key: '2', configured: true },
      { job_id: 'build', configured: true },
      { job_id: 'retired', configured: false },
    ];
    expect(alwaysRunJobChoices(tests, ['build', 'gone'])).toEqual([
      { id: 'build', configured: true },
      { id: 'server-tests', configured: true },
      { id: 'gone', configured: false },
    ]);
  });

  it('handles missing stats', () => {
    expect(alwaysRunJobChoices(null, [])).toEqual([]);
    expect(alwaysRunJobChoices(undefined, ['lint'])).toEqual([{ id: 'lint', configured: false }]);
  });
});

describe('dynamicModeBlockedReason', () => {
  it('blocks turning dynamic on while CI on push is off', () => {
    expect(dynamicModeBlockedReason('full', false)).toBe(DYNAMIC_NEEDS_CI_ON_PUSH_HINT);
  });

  it('allows it with CI on push, and always allows turning dynamic off', () => {
    expect(dynamicModeBlockedReason('full', true)).toBeNull();
    expect(dynamicModeBlockedReason('dynamic', false)).toBeNull();
  });
});

describe('testSelectionSaveError', () => {
  it('strips the status prefix from a server 400', () => {
    expect(
      testSelectionSaveError(
        new Error('400: testSelection.alwaysRun must be a list of at most 100 strings'),
      ),
    ).toBe('testSelection.alwaysRun must be a list of at most 100 strings');
  });

  it('falls back to generic copy', () => {
    expect(testSelectionSaveError(new Error(''))).toBe('Failed to save test selection');
    expect(testSelectionSaveError('oops')).toBe('oops');
  });
});
