import '../test/setup.js';
import { describe, it, expect } from 'vitest';
import { parsePushOptionsHeader } from './smart-http.js';

describe('parsePushOptionsHeader', () => {
  it('splits the comma-joined header, trims, and de-dupes', () => {
    expect(parsePushOptionsHeader('automerge,')).toEqual(['automerge']);
    expect(parsePushOptionsHeader('automerge, ci.skip ,automerge')).toEqual([
      'automerge',
      'ci.skip',
    ]);
  });

  it('treats missing/empty headers as no options', () => {
    expect(parsePushOptionsHeader(undefined)).toEqual([]);
    expect(parsePushOptionsHeader('')).toEqual([]);
    expect(parsePushOptionsHeader(',,')).toEqual([]);
  });

  it('joins a repeated header (array form) before splitting', () => {
    expect(parsePushOptionsHeader(['automerge', 'auto-merge'])).toEqual([
      'automerge',
      'auto-merge',
    ]);
  });
});
