// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  insertTranscriptAtAnchor,
  baseAudioContentType,
  contentTypeForRecordingUri,
} from './voiceTranscription';
describe('insertTranscriptAtAnchor', () => {
  it('appends when anchor is null', () => {
    expect(insertTranscriptAtAnchor('hello', 'world', null)).toBe('hello world');
  });
  it('splices at anchor with spacing', () => {
    expect(insertTranscriptAtAnchor('foo bar', 'baz', 3)).toBe('foo baz bar');
  });
  it('returns prev when transcript is empty', () => {
    expect(insertTranscriptAtAnchor('hello', '   ', 0)).toBe('hello');
    expect(insertTranscriptAtAnchor('hello', '', 0)).toBe('hello');
  });
  it('clamps anchor to string bounds', () => {
    expect(insertTranscriptAtAnchor('ab', 'x', 99)).toBe('ab x');
    expect(insertTranscriptAtAnchor('ab', 'x', -5)).toBe('x ab');
  });
});
describe('baseAudioContentType', () => {
  it('strips codec parameters', () => {
    expect(baseAudioContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseAudioContentType('AUDIO/MP4 ; codecs=mp4a.40.2')).toBe('audio/mp4');
    expect(baseAudioContentType('')).toBe('audio/m4a');
  });
});
describe('contentTypeForRecordingUri', () => {
  it('maps common recording extensions', () => {
    expect(contentTypeForRecordingUri('file:///rec.m4a')).toBe('audio/m4a');
    expect(contentTypeForRecordingUri('file:///rec.mp4')).toBe('audio/mp4');
    expect(contentTypeForRecordingUri('file:///rec.webm')).toBe('audio/webm');
  });
  it('defaults to audio/m4a for unknown extensions', () => {
    expect(contentTypeForRecordingUri('file:///rec.xyz')).toBe('audio/m4a');
    expect(contentTypeForRecordingUri('')).toBe('audio/m4a');
  });
});
