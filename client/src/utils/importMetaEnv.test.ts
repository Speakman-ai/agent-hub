import { describe, it, expect } from 'vitest';
import { importMetaEnv } from './importMetaEnv';

describe('importMetaEnv', () => {
  it('returns the Vite env bag without throwing', () => {
    const env = importMetaEnv();
    // Under Vitest `import.meta.env` is always present (jsdom + Vite). It must be
    // a truthy object, and the shared accessor must never throw.
    expect(env).toBeTruthy();
    expect(typeof env).toBe('object');
  });

  it('exposes VITE_-prefixed build vars set by the test env', () => {
    // vitest.config.ts sets VITE_BUG_REPORT_ENDPOINT for the record-on-error
    // replay suite; the accessor surfaces it like any other Vite env var.
    expect(importMetaEnv().VITE_BUG_REPORT_ENDPOINT).toBe(
      'https://hub.example.test/api/bug-reports',
    );
  });
});
