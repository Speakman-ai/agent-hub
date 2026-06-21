import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  filterComposeLogLinesForUi,
  healthCheckRequestInit,
  healthProbeHostHeader,
  probePreviewHealth,
} from './preview-health-fetch.js';

describe('healthProbeHostHeader', () => {
  it('maps host.docker.internal to localhost', () => {
    expect(healthProbeHostHeader('host.docker.internal')).toBe('localhost');
  });

  it('returns undefined for loopback hostnames', () => {
    expect(healthProbeHostHeader('localhost')).toBeUndefined();
    expect(healthProbeHostHeader('127.0.0.1')).toBeUndefined();
  });
});

describe('healthCheckRequestInit', () => {
  it('sets Host localhost for host.docker.internal probes', () => {
    expect(healthCheckRequestInit('http://host.docker.internal:4100/')).toEqual({
      headers: { Host: 'localhost' },
    });
  });
});

describe('filterComposeLogLinesForUi', () => {
  it('drops postgres service lines from compose log tail', () => {
    const lines = [
      'backend-1  | ==> [preview] Postgres ready',
      'db-1       | 2026-05-22 LOG:  checkpoint starting: wal',
      'frontend-1 | Watch mode enabled.',
    ];
    expect(filterComposeLogLinesForUi(lines)).toEqual([
      'backend-1  | ==> [preview] Postgres ready',
      'frontend-1 | Watch mode enabled.',
    ]);
  });
});

describe('probePreviewHealth — Host override (Vite/Angular allowedHosts)', () => {
  // Emulates a Vite/Angular dev server's `allowedHosts` gate: any request
  // whose `Host` header isn't `localhost` gets a 403. This is exactly what
  // breaks compose previews when the Hub runs in Docker and probes the
  // host-published port via `host.docker.internal` — the probe MUST rewrite
  // `Host` to `localhost` or it 403s forever and the preview never flips to
  // `ready`. We use 127.0.0.2 (loopback, but NOT one of the literal strings
  // `healthProbeHostHeader` treats as loopback) to trigger the override path
  // without needing real DNS for `host.docker.internal`.
  function startAllowedHostsServer(): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const host = (req.headers.host ?? '').split(':')[0];
        if (host === 'localhost') {
          res.statusCode = 200;
          res.end('ok');
        } else {
          // Vite returns its index.html shell with a 403 for blocked hosts.
          res.statusCode = 403;
          res.end('Blocked request. This host is not allowed.');
        }
      });
      server.listen(0, '0.0.0.0', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ port, close: () => server.close() });
      });
    });
  }

  it('rewrites a non-loopback Host to localhost so an allowedHosts gate passes', async () => {
    const { port, close } = await startAllowedHostsServer();
    try {
      // 127.0.0.2 -> healthProbeHostHeader returns 'localhost', so the probe
      // sends Host: localhost and the gate returns 200.
      const viaProbe = await probePreviewHealth(`http://127.0.0.2:${port}/`);
      expect(viaProbe).toEqual({ ok: true, statusCode: 200 });

      // Contrast: undici's global fetch ignores a manual Host override, so it
      // sends Host: 127.0.0.2 and the gate 403s. This is the production
      // failure mode the probe exists to avoid — asserting it here documents
      // why compose health checks must NOT route through undici `fetch`.
      const viaUndici = await fetch(`http://127.0.0.2:${port}/`, {
        method: 'GET',
        redirect: 'manual',
        headers: { Host: 'localhost' },
      });
      expect(viaUndici.status).toBe(403);
    } finally {
      close();
    }
  });

  it('does not rewrite Host for literal localhost (no gate bypass needed)', async () => {
    const { port, close } = await startAllowedHostsServer();
    try {
      const res = await probePreviewHealth(`http://localhost:${port}/`);
      expect(res).toEqual({ ok: true, statusCode: 200 });
    } finally {
      close();
    }
  });
});
