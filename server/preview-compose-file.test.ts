import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildComposePreviewChecklist } from './preview-compose-checklist.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

/** Parse a Go/compose-style duration string (e.g. `10s`, `1m`, `1m30s`) to ms. */
function parseComposeDurationMs(value: string): number {
  let ms = 0;
  const re = /(\d+)(ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const n = Number(m[1]);
    ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return ms;
}

describe('compose.preview.yml', () => {
  it('satisfies required compose preview checklist items', () => {
    const checklist = buildComposePreviewChecklist({
      workspaceDir: REPO_ROOT,
      composeFile: 'compose.preview.yml',
      entryService: 'client',
      entryPort: 80,
    });

    expect(checklist.filter((item) => item.status === 'fail')).toEqual([]);
  });

  // Regression guard for the "preview started but marked as failed" report:
  // the `server` healthcheck budget was once start_period 10s + 3×30s ≈ 100s,
  // far below the 600s ready timeout the same file declares. A cold Hub boot
  // (tsx start, SQLite init, migrations) blew that budget, compose marked
  // `server` unhealthy, `up` exited non-zero, and the preview failed even
  // though it was merely slow. The dependent `client` blocks on the server's
  // healthcheck (`depends_on: service_healthy`), so the budget must give a
  // realistic cold boot room to pass.
  it('gives the server healthcheck a cold-boot-realistic budget under the ready timeout', () => {
    const doc = parseYaml(readFileSync(`${REPO_ROOT}compose.preview.yml`, 'utf8')) as {
      services: Record<string, any>;
    };
    const server = doc.services.server;
    const hc = server.healthcheck as {
      interval: string;
      retries: number;
      start_period: string;
    };

    const startPeriodMs = parseComposeDurationMs(hc.start_period);
    const intervalMs = parseComposeDurationMs(hc.interval);
    // Failures only count toward `retries` after `start_period` elapses, so
    // the worst-case time before compose declares the service unhealthy is
    // roughly start_period + retries × interval.
    const budgetMs = startPeriodMs + hc.retries * intervalMs;

    // Must tolerate a multi-minute cold boot (the old ~100s budget did not).
    expect(budgetMs).toBeGreaterThanOrEqual(300_000);

    // …but stay below the declared 10-minute ready timeout, so the Hub's own
    // readiness poll — not the container healthcheck — owns the final verdict.
    const readyEnv = (server.environment as string[]).find((e) =>
      e.startsWith('AGENT_HUB_PREVIEW_READY_TIMEOUT_MS='),
    );
    const readyTimeoutMs = Number(
      (readyEnv ?? '').split(':-')[1]?.replace(/\}.*$/, '') || '600000',
    );
    expect(budgetMs).toBeLessThanOrEqual(readyTimeoutMs);

    // The coupling that makes the budget matter: client waits on server health.
    expect(doc.services.client.depends_on.server.condition).toBe('service_healthy');
  });
});
