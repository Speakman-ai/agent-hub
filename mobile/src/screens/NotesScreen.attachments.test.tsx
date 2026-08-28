import { describe, it, expect, vi } from 'vitest';

// NotesScreen pulls in native modules at import; stub them so the pure
// attachment helpers below are importable in the node test env.
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  FlatList: 'FlatList',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Alert: { alert: vi.fn() },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  Modal: 'Modal',
  Image: 'Image',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.test' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../context/SidebarContext', () => ({ SidebarContext: { Provider: 'Provider' } }));

import { nextPendingRangeOnEdit, computeAttachInsertion } from './NotesScreen';

const IMG = '\n![shot.png](/uploads/shot.png)\n';

describe('mobile note attachment — insertion at the selected range', () => {
  it('replaces the selected range with the attachment', () => {
    const pending = { range: { start: 2, end: 4 }, session: 1 };
    const out = computeAttachInsertion({
      session: 1,
      currentSession: 1,
      pending,
      baseText: 'abcdef',
      snippet: IMG,
    });
    expect(out).not.toBeNull();
    expect(out!.text).toBe('ab' + IMG + 'ef');
  });

  it('falls back to end-of-content when there is no live pending anchor', () => {
    const out = computeAttachInsertion({
      session: 3,
      currentSession: 3,
      pending: null,
      baseText: 'hello',
      snippet: IMG,
    });
    expect(out!.text).toBe('hello' + IMG);
  });
});

describe('mobile note attachment — preservation across concurrent edits', () => {
  it('re-anchors the pending range as the user types before it, then inserts there', () => {
    let pending = { range: { start: 3, end: 3 }, session: 1 }; // caret after "abc"
    // User types "XY" at the very start while the upload is pending.
    pending = nextPendingRangeOnEdit(pending, 'abc', 'XYabc')!;
    expect(pending.range).toEqual({ start: 5, end: 5 });

    const out = computeAttachInsertion({
      session: 1,
      currentSession: 1,
      pending,
      baseText: 'XYabc',
      snippet: IMG,
    });
    // Attachment lands AFTER "abc" (its intended logical spot), not inside "XY".
    expect(out!.text).toBe('XYabc' + IMG);
  });

  it('collapses the range when the user edits inside a selection (no lost text)', () => {
    let pending = { range: { start: 3, end: 5 }, session: 1 }; // "de" selected
    pending = nextPendingRangeOnEdit(pending, 'abcdef', 'abcdZef')!; // type "Z" inside
    expect(pending.range.start).toBe(pending.range.end); // collapsed to a caret
    const out = computeAttachInsertion({
      session: 1,
      currentSession: 1,
      pending,
      baseText: 'abcdZef',
      snippet: IMG,
    });
    expect(out!.text).toContain('Z'); // the freshly typed character survives
  });
});

describe('mobile note attachment — rejection after cancel / switching sessions', () => {
  it('drops the completion when the edit session changed', () => {
    const pending = { range: { start: 0, end: 0 }, session: 1 };
    const out = computeAttachInsertion({
      session: 1,
      currentSession: 2, // user canceled/switched → session advanced
      pending,
      baseText: 'unrelated new note',
      snippet: IMG,
    });
    expect(out).toBeNull();
  });

  it('clears a pending anchor when its session is invalidated (bumpEditSession semantics)', () => {
    // nextPendingRangeOnEdit only tracks; a null pending stays null (post-bump).
    expect(nextPendingRangeOnEdit(null, 'abc', 'abcd')).toBeNull();
  });
});
