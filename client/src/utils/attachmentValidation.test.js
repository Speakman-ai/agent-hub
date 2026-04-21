import { describe, it, expect } from 'vitest';
import {
  validateAttachmentFile,
  partitionAttachmentFiles,
  MAX_ATTACHMENT_BYTES,
} from './attachmentValidation.js';

describe('validateAttachmentFile', () => {
  it('accepts a normal-sized video file', () => {
    const file = { size: 5 * 1024 * 1024, name: 'demo.mp4', type: 'video/mp4' };
    expect(validateAttachmentFile(file)).toBeNull();
  });

  it('rejects a file at or above the 100 MB limit with a size-explaining message', () => {
    const file = { size: MAX_ATTACHMENT_BYTES + 1, name: 'big.mov', type: 'video/quicktime' };
    const msg = validateAttachmentFile(file);
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/big\.mov/);
    expect(msg).toMatch(/max attachment size/i);
    // The message should include a human-readable size so the user understands why
    expect(msg).toMatch(/MB/);
  });

  it('rejects an empty file', () => {
    const file = { size: 0, name: 'zero.mp4', type: 'video/mp4' };
    expect(validateAttachmentFile(file)).toMatch(/empty/i);
  });

  it('honors a custom maxBytes override', () => {
    const file = { size: 200, name: 'tiny.mp4', type: 'video/mp4' };
    expect(validateAttachmentFile(file, { maxBytes: 100 })).toMatch(/max attachment size/i);
    expect(validateAttachmentFile(file, { maxBytes: 1024 })).toBeNull();
  });

  it('returns a generic message when no file is provided', () => {
    expect(validateAttachmentFile(null)).toMatch(/no file/i);
    expect(validateAttachmentFile(undefined)).toMatch(/no file/i);
  });
});

describe('partitionAttachmentFiles', () => {
  it('splits the input into accepted and rejected lists, preserving reasons', () => {
    const ok = { size: 1024, name: 'ok.mp4', type: 'video/mp4' };
    const tooBig = {
      size: MAX_ATTACHMENT_BYTES + 10,
      name: 'huge.mov',
      type: 'video/quicktime',
    };
    const empty = { size: 0, name: 'empty.webm', type: 'video/webm' };

    const { accepted, rejected } = partitionAttachmentFiles([ok, tooBig, empty]);
    expect(accepted).toEqual([ok]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].file).toBe(tooBig);
    expect(rejected[0].reason).toMatch(/max attachment size/i);
    expect(rejected[1].file).toBe(empty);
    expect(rejected[1].reason).toMatch(/empty/i);
  });

  it('returns empty arrays for an empty input', () => {
    expect(partitionAttachmentFiles([])).toEqual({ accepted: [], rejected: [] });
  });
});
