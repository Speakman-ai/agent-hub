import http from 'http';
import {
  extractOAuthUrl,
  extractStateFromUrl,
  proxyCallbackToLocalServer,
} from '../routes/claude-auth.js';

describe('extractOAuthUrl', () => {
  it('extracts URL from "visit: https://..." text', () => {
    const text = 'Please visit: https://console.anthropic.com/oauth?client_id=abc&state=xyz';
    expect(extractOAuthUrl(text)).toBe(
      'https://console.anthropic.com/oauth?client_id=abc&state=xyz',
    );
  });

  it('is case-insensitive on the "visit:" prefix', () => {
    const text = 'Visit: https://example.com/oauth';
    expect(extractOAuthUrl(text)).toBe('https://example.com/oauth');
  });

  it('returns null when no URL is present', () => {
    expect(extractOAuthUrl('Waiting for login...')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractOAuthUrl('')).toBeNull();
  });
});

describe('extractStateFromUrl', () => {
  it('extracts state from URL with state as first param', () => {
    expect(extractStateFromUrl('https://example.com/cb?state=abc123')).toBe('abc123');
  });

  it('extracts state from URL with state as second param', () => {
    expect(extractStateFromUrl('https://example.com/cb?code=xyz&state=abc123')).toBe('abc123');
  });

  it('handles URL-safe characters in state (alphanumeric, dash, underscore)', () => {
    expect(extractStateFromUrl('https://example.com/cb?state=aB3_-xY')).toBe('aB3_-xY');
  });

  it('returns null when state param is missing', () => {
    expect(extractStateFromUrl('https://example.com/cb?code=xyz')).toBeNull();
  });

  it('returns null for URL with no query params', () => {
    expect(extractStateFromUrl('https://example.com/cb')).toBeNull();
  });
});

describe('proxyCallbackToLocalServer', () => {
  let server: http.Server;
  let port: number;

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (server) server.close(() => resolve());
        else resolve();
      }),
  );

  function startServer(handler: http.RequestListener): Promise<number> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(port);
      });
    });
  }

  it('proxies to the local server and returns success', async () => {
    const p = await startServer((req, res) => {
      // Verify the code and state are forwarded correctly
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      expect(url.pathname).toBe('/callback');
      expect(url.searchParams.get('code')).toBe('auth_code_123');
      expect(url.searchParams.get('state')).toBe('state_abc');
      res.writeHead(200);
      res.end('OK');
    });

    const result = await proxyCallbackToLocalServer(p, 'auth_code_123', 'state_abc');
    expect(result.status).toBe(200);
    expect(result.body).toBe('OK');
  });

  it('returns error status when CLI server rejects the callback', async () => {
    const p = await startServer((_req, res) => {
      res.writeHead(400);
      res.end('Invalid state');
    });

    const result = await proxyCallbackToLocalServer(p, 'code', 'bad_state');
    expect(result.status).toBe(400);
    expect(result.body).toBe('Invalid state');
  });

  it('returns 500 when the server is not reachable', async () => {
    // Use a port that nothing is listening on
    const result = await proxyCallbackToLocalServer(19999, 'code', 'state');
    expect(result.status).toBe(500);
    expect(result.body).toBeTruthy();
  });

  it('encodes special characters in code and state', async () => {
    const p = await startServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      expect(url.searchParams.get('code')).toBe('code with spaces&special=chars');
      expect(url.searchParams.get('state')).toBe('state/with/slashes');
      res.writeHead(200);
      res.end('OK');
    });

    const result = await proxyCallbackToLocalServer(
      p,
      'code with spaces&special=chars',
      'state/with/slashes',
    );
    expect(result.status).toBe(200);
  });
});

describe('callback code extraction logic', () => {
  // Tests the extraction logic used in the /callback route handler
  function extractAuthCode(input: string): string {
    let authCode = input.trim();
    const codeFromUrl = authCode.match(/[?&]code=([^&\s]+)/);
    if (codeFromUrl) {
      authCode = decodeURIComponent(codeFromUrl[1]);
    }
    return authCode;
  }

  it('returns a bare code string as-is', () => {
    expect(extractAuthCode('abc123')).toBe('abc123');
  });

  it('extracts code from a full callback URL', () => {
    expect(
      extractAuthCode('https://platform.claude.com/oauth/callback?code=the_real_code&state=xyz'),
    ).toBe('the_real_code');
  });

  it('extracts code when it is the only query param', () => {
    expect(extractAuthCode('https://example.com/cb?code=only_code')).toBe('only_code');
  });

  it('decodes URL-encoded code values', () => {
    expect(extractAuthCode('https://example.com/cb?code=has%20spaces%26more')).toBe(
      'has spaces&more',
    );
  });

  it('trims whitespace from input', () => {
    expect(extractAuthCode('  abc123  ')).toBe('abc123');
  });
});
