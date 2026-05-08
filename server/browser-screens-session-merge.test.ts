// @ts-nocheck — shared helper is plain JS without typings.
import { describe, it, expect } from 'vitest';
import { mergeBrowserActivityScreenshot } from '../shared/utils/browserScreensBySessionMerge.js';

describe('mergeBrowserActivityScreenshot', () => {
  it('nests screenshots under session then message without clobbering other sessions', () => {
    const s1 = mergeBrowserActivityScreenshot(
      {},
      'sess-a',
      'msg-1',
      'act-x',
      'data:image/jpeg;base64,QQ==',
    );
    expect(s1).toEqual({
      'sess-a': { 'msg-1': { 'act-x': 'data:image/jpeg;base64,QQ==' } },
    });
    const s2 = mergeBrowserActivityScreenshot(
      s1,
      'sess-b',
      'msg-9',
      'act-y',
      'data:image/jpeg;base64,Ag==',
    );
    expect(s2['sess-a']).toEqual({ 'msg-1': { 'act-x': 'data:image/jpeg;base64,QQ==' } });
    expect(s2['sess-b']).toEqual({ 'msg-9': { 'act-y': 'data:image/jpeg;base64,Ag==' } });
  });

  it('extends action map for the same message', () => {
    const prev = {
      sid: {
        mid: { a1: 'u1', a2: 'u2' },
      },
    };
    const next = mergeBrowserActivityScreenshot(prev, 'sid', 'mid', 'a3', 'u3');
    expect(next.sid.mid).toEqual({ a1: 'u1', a2: 'u2', a3: 'u3' });
  });

  it('returns prev when identifiers are invalid', () => {
    const prev = { sid: {} };
    expect(mergeBrowserActivityScreenshot(prev, '', 'm', 'a', 'u')).toBe(prev);
    expect(mergeBrowserActivityScreenshot(prev, 's', '', 'a', 'u')).toBe(prev);
    expect(mergeBrowserActivityScreenshot(prev, 's', 'm', '', 'u')).toBe(prev);
    expect(mergeBrowserActivityScreenshot(prev, 's', 'm', 'a', '')).toBe(prev);
  });
});
