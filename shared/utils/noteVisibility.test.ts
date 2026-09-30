import { describe, it, expect } from 'vitest';
import { describeNoteVisibility } from './noteVisibility';

describe('describeNoteVisibility', () => {
  it('reads an owned private note as manageable', () => {
    expect(describeNoteVisibility({ shared: false, can_manage: true })).toMatchObject({
      shared: false,
      canManage: true,
      label: 'Private',
    });
  });

  it('names the owner of a teammate’s shared note', () => {
    const v = describeNoteVisibility({ shared: true, can_manage: false, owner_username: 'alice' });
    expect(v).toMatchObject({ shared: true, canManage: false, label: 'Shared' });
    expect(v.hint).toContain('alice');
  });

  it('treats rows without sharing fields as shared and manageable', () => {
    expect(describeNoteVisibility({})).toMatchObject({ shared: true, canManage: true });
  });
});
