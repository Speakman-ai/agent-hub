import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS,
  PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS,
  PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS,
} from './preview-ready-timeout-bounds.js';

describe('preview ready-timeout bounds', () => {
  it('keeps the default at 10 minutes (no behavior change for opt-out projects)', () => {
    expect(DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS).toBe(600_000);
  });

  it('floors the band at 5 seconds', () => {
    expect(PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS).toBe(5_000);
  });

  it('raises the ceiling to 60 minutes for heavy cold boots (multi-GB restore + compile)', () => {
    expect(PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS).toBe(3_600_000);
  });

  it('keeps the default inside the band', () => {
    expect(DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      PREVIEW_COMPOSE_READY_TIMEOUT_MIN_MS,
    );
    expect(DEFAULT_PREVIEW_COMPOSE_READY_TIMEOUT_MS).toBeLessThanOrEqual(
      PREVIEW_COMPOSE_READY_TIMEOUT_MAX_MS,
    );
  });
});
