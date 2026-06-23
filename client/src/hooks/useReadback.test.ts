import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useReadback from './useReadback';

// Minimal fake Web Speech API. Captures the text of each utterance spoken.
function installSpeechMock() {
  const spoken: any[] = [];
  const cancel = vi.fn();
  (window as any).SpeechSynthesisUtterance = class {
    constructor(text: any) {
      (this as any).text = text;
    }
  };
  (window as any).speechSynthesis = {
    speak: (u: any) => spoken.push(u.text),
    cancel,
  };
  return { spoken, cancel };
}

describe('useReadback', () => {
  let mock: any;

  beforeEach(() => {
    window.localStorage.clear();
    mock = installSpeechMock();
  });

  afterEach(() => {
    delete (window as any).speechSynthesis;
    delete (window as any).SpeechSynthesisUtterance;
    vi.restoreAllMocks();
  });

  it('reports supported when speech APIs exist and defaults disabled', () => {
    const { result } = renderHook(() => useReadback());
    expect(result!.current.supported).toBe(true);
    expect(result!.current.enabled).toBe(false);
  });

  it('does not speak while disabled', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.feed('m1', 'Hello there. How are you?'));
    expect(mock.spoken).toEqual([]);
  });

  it('speaks complete sentences once enabled, holding the trailing fragment', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle()); // enable
    act(() => result.current.feed('m1', 'First done. Second pending'));
    expect(mock.spoken).toEqual(['First done.']);
  });

  it('does not re-speak text across incremental feeds', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle());
    act(() => result.current.feed('m1', 'Alpha one. Beta tw'));
    act(() => result.current.feed('m1', 'Alpha one. Beta two. Gamma'));
    expect(mock.spoken).toEqual(['Alpha one.', 'Beta two.']);
  });

  it('flush speaks the trailing fragment at end of stream', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle());
    act(() => result.current.feed('m1', 'Done part. Tail with no period'));
    act(() => result.current.flush('m1', 'Done part. Tail with no period'));
    expect(mock.spoken).toEqual(['Done part.', 'Tail with no period']);
  });

  it('never speaks code inside an unterminated fence', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle());
    act(() => result.current.feed('m1', 'Here is the patch.\n```js\nconst secret = 1;'));
    expect(mock.spoken).toEqual(['Here is the patch.']);
    expect(mock.spoken.join(' ')).not.toContain('secret');
  });

  it('cancel stops playback and resets tracking', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle());
    act(() => result.current.feed('m1', 'One sentence. '));
    act(() => result.current.cancel());
    expect(mock.cancel).toHaveBeenCalled();
    // After cancel, the same message re-feeds from scratch.
    act(() => result.current.feed('m1', 'One sentence. '));
    expect(mock.spoken).toEqual(['One sentence.', 'One sentence.']);
  });

  it('persists the enabled flag to localStorage', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle());
    expect(window.localStorage.getItem('agentHub.readbackEnabled')).toBe('1');
    act(() => result.current.toggle());
    expect(window.localStorage.getItem('agentHub.readbackEnabled')).toBe('0');
    expect(mock.cancel).toHaveBeenCalled(); // turning off stops playback
  });

  it('starting a new message cancels the previous playback', () => {
    const { result } = renderHook(() => useReadback());
    act(() => result.current.toggle());
    act(() => result.current.feed('m1', 'Message one. '));
    (mock.cancel as any).mockClear();
    act(() => result.current.feed('m2', 'Message two. '));
    expect(mock.cancel).toHaveBeenCalled();
    expect(mock.spoken).toEqual(['Message one.', 'Message two.']);
  });
});

describe('useReadback without speech support', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete (window as any).speechSynthesis;
    delete (window as any).SpeechSynthesisUtterance;
  });

  it('reports unsupported and stays disabled', () => {
    const { result } = renderHook(() => useReadback());
    expect(result!.current.supported).toBe(false);
    expect(result!.current.enabled).toBe(false);
    // feed/flush are safe no-ops.
    act(() => result.current.feed('m1', 'Anything.'));
    act(() => result.current.flush('m1', 'Anything.'));
  });
});
