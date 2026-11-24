import { describe, expect, it } from 'vitest';
import {
  groupSessionsByFolder,
  withSessionFolder,
  withoutSessionFolder,
  type SessionFolderListingWire,
} from './sessionFolders';

const folder = (id: string, position: number) => ({
  id,
  agentId: 'a',
  name: id,
  position,
  createdAt: '2026-01-01 00:00:00',
});

const listing: SessionFolderListingWire = {
  folders: [folder('later', 1), folder('first', 0), folder('empty', 2)],
  assignments: { s2: 'first', s3: 'later', s4: 'gone' },
};

const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }];

describe('groupSessionsByFolder', () => {
  it('returns everything unfiled when there are no folders', () => {
    expect(groupSessionsByFolder(sessions, null)).toEqual({ folders: [], unfiled: sessions });
    expect(groupSessionsByFolder(sessions, { folders: [], assignments: { s1: 'x' } }).unfiled).toBe(
      sessions,
    );
  });

  it('groups in folder order, keeps empty folders, and unfiles dangling filings', () => {
    const grouped = groupSessionsByFolder(sessions, listing);
    expect(grouped.folders.map((g) => [g.folder.id, g.sessions.map((s) => s.id)])).toEqual([
      ['first', ['s2']],
      ['later', ['s3']],
      ['empty', []],
    ]);
    expect(grouped.unfiled.map((s) => s.id)).toEqual(['s1', 's4', 's5']);
  });
});

describe('listing updates', () => {
  it('files, refiles, and unfiles without mutating the input', () => {
    const filed = withSessionFolder(listing, 's1', 'empty');
    expect(filed.assignments.s1).toBe('empty');
    expect(listing.assignments.s1).toBeUndefined();
    expect(withSessionFolder(filed, 's1', null).assignments.s1).toBeUndefined();
  });

  it('drops a folder and its filings', () => {
    const next = withoutSessionFolder(listing, 'first');
    expect(next.folders.map((f) => f.id)).toEqual(['later', 'empty']);
    expect(next.assignments).toEqual({ s3: 'later', s4: 'gone' });
  });
});
