import { describe, expect, it } from 'vitest';
import {
  browserPaneStatusLabel,
  fitFrameInBox,
  keyInputFromDomEvent,
  mapPointerToViewport,
  normalizeUrlBarInput,
} from './browserPaneInput';

describe('mapPointerToViewport', () => {
  it('scales a pointer inside the rendered image to viewport CSS px', () => {
    expect(
      mapPointerToViewport(
        { x: 320, y: 180 },
        { width: 640, height: 360 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 640, y: 360 });
  });
  it('clamps to the viewport and drops unknown geometry', () => {
    expect(
      mapPointerToViewport(
        { x: -5, y: 9999 },
        { width: 640, height: 360 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 0, y: 720 });
    expect(
      mapPointerToViewport({ x: 1, y: 1 }, { width: 0, height: 0 }, { width: 1, height: 1 }),
    ).toBeNull();
    expect(mapPointerToViewport({ x: 1, y: 1 }, { width: 10, height: 10 }, null)).toBeNull();
  });
});

describe('fitFrameInBox', () => {
  it('fits preserving aspect ratio and never upscales', () => {
    expect(fitFrameInBox({ width: 1280, height: 720 }, { width: 640, height: 640 })).toEqual({
      width: 640,
      height: 360,
    });
    expect(fitFrameInBox({ width: 100, height: 50 }, { width: 640, height: 640 })).toEqual({
      width: 100,
      height: 50,
    });
    expect(fitFrameInBox(null, { width: 640, height: 640 })).toEqual({ width: 0, height: 0 });
  });
});

describe('keyInputFromDomEvent', () => {
  it('forwards printable keys and named keys, with modifiers', () => {
    expect(keyInputFromDomEvent({ key: 'a' })).toEqual({ kind: 'key', type: 'press', key: 'a' });
    expect(keyInputFromDomEvent({ key: 'Enter' })).toEqual({
      kind: 'key',
      type: 'press',
      key: 'Enter',
    });
    expect(keyInputFromDomEvent({ key: 'ArrowLeft', shiftKey: true })).toEqual({
      kind: 'key',
      type: 'press',
      key: 'ArrowLeft',
      modifiers: { shift: true },
    });
    expect(keyInputFromDomEvent({ key: 'a', ctrlKey: true })).toEqual({
      kind: 'key',
      type: 'press',
      key: 'a',
      modifiers: { ctrl: true },
    });
  });
  it('leaves modifiers, IME composition, unknown keys, and browser chords alone', () => {
    expect(keyInputFromDomEvent({ key: 'Shift' })).toBeNull();
    expect(keyInputFromDomEvent({ key: 'a', isComposing: true })).toBeNull();
    expect(keyInputFromDomEvent({ key: 'CapsLock' })).toBeNull();
    expect(keyInputFromDomEvent({ key: 'l', ctrlKey: true })).toBeNull();
    expect(keyInputFromDomEvent({ key: 'w', metaKey: true })).toBeNull();
  });
});

describe('normalizeUrlBarInput', () => {
  it('adds https to bare hosts and keeps explicit schemes', () => {
    expect(normalizeUrlBarInput('example.com/x')).toBe('https://example.com/x');
    expect(normalizeUrlBarInput('http://example.com')).toBe('http://example.com');
    expect(normalizeUrlBarInput('localhost:3000/x')).toBe('https://localhost:3000/x');
    expect(normalizeUrlBarInput('ftp://x/')).toBe('ftp://x/');
    expect(normalizeUrlBarInput('mailto:a@b')).toBe('mailto:a@b');
    expect(normalizeUrlBarInput('  ')).toBeNull();
  });
});

describe('browserPaneStatusLabel', () => {
  it('labels every status', () => {
    expect(browserPaneStatusLabel('waiting')).toMatch(/Waiting/);
    expect(browserPaneStatusLabel('live')).toBe('Live');
    expect(browserPaneStatusLabel('closed')).toMatch(/closed/);
  });
});
