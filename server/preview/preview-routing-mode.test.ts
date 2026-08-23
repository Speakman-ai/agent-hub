import { describe, expect, it } from 'vitest';
import {
  PATH_PREFIX_PREVIEW_ERROR,
  deriveLocalDockerPreviewSubdomainBase,
  pathPrefixPreviewsAllowed,
  previewRoutingBlockReason,
  resolvePreviewRoutingMode,
} from './preview-routing-mode.js';

describe('resolvePreviewRoutingMode', () => {
  it('is direct when no public URL is configured', () => {
    // Local dev / Electron: the browser and the dev server share a machine,
    // so the iframe hits the port directly and no proxy is involved.
    expect(resolvePreviewRoutingMode({ publicUrl: null, subdomainBase: null })).toBe('direct');
    expect(resolvePreviewRoutingMode({ publicUrl: '   ', subdomainBase: 'p.example.com' })).toBe(
      'direct',
    );
  });

  it('is subdomain when a public URL and a wildcard base are both set', () => {
    expect(
      resolvePreviewRoutingMode({
        publicUrl: 'https://hub.example.com',
        subdomainBase: 'preview.hub.example.com',
      }),
    ).toBe('subdomain');
  });

  it('is path-prefix when the wildcard base is missing on a hosted deployment', () => {
    expect(
      resolvePreviewRoutingMode({ publicUrl: 'https://hub.example.com', subdomainBase: '' }),
    ).toBe('path-prefix');
  });

  it('is subdomain for a LAN hostname even without an explicit wildcard base', () => {
    expect(
      resolvePreviewRoutingMode({
        publicUrl: 'http://hub.local',
        subdomainBase: null,
      }),
    ).toBe('subdomain');
  });
});

describe('deriveLocalDockerPreviewSubdomainBase', () => {
  it('derives preview.<host> for loopback and LAN suffixes without a compose flag', () => {
    expect(deriveLocalDockerPreviewSubdomainBase('http://hub.local')).toBe('preview.hub.local');
    expect(deriveLocalDockerPreviewSubdomainBase('http://agenthub.lan')).toBe(
      'preview.agenthub.lan',
    );
    expect(deriveLocalDockerPreviewSubdomainBase('http://localhost:3050')).toBe(
      'preview.localhost:3050',
    );
  });

  it('preserves a non-default web port so AGENT_HUB_WEB_PORT=8080 stays reachable', () => {
    // Compose maps nginx to AGENT_HUB_WEB_PORT (commonly 8080). Dropping
    // that port made the iframe dial :80 while the Hub listened only on 8080.
    expect(deriveLocalDockerPreviewSubdomainBase('http://hub.local:8080')).toBe(
      'preview.hub.local:8080',
    );
    expect(deriveLocalDockerPreviewSubdomainBase('http://hub.local')).toBe('preview.hub.local');
    expect(deriveLocalDockerPreviewSubdomainBase('http://hub.local:80')).toBe('preview.hub.local');
  });

  it('does not special-case a public TLD when the compose flag is unset', () => {
    // local.agenthub.com is one operator's DNS, not a product hostname.
    expect(deriveLocalDockerPreviewSubdomainBase('http://local.agenthub.com')).toBeNull();
    expect(deriveLocalDockerPreviewSubdomainBase('http://hub.mycompany.net')).toBeNull();
  });

  it('derives whatever AGENT_HUB_PUBLIC_URL host compose published when the flag is on', () => {
    const env = { AGENT_HUB_PREVIEW_LOCAL_DOCKER: '1' };
    expect(deriveLocalDockerPreviewSubdomainBase('http://local.agenthub.com', env)).toBe(
      'preview.local.agenthub.com',
    );
    expect(deriveLocalDockerPreviewSubdomainBase('http://hub.mycompany.net', env)).toBe(
      'preview.hub.mycompany.net',
    );
  });

  it('does not derive for production public URLs', () => {
    expect(deriveLocalDockerPreviewSubdomainBase('https://agenthub.surveytracker.io')).toBeNull();
    expect(deriveLocalDockerPreviewSubdomainBase('https://hub.example.com')).toBeNull();
  });

  it('can be disabled with AGENT_HUB_PREVIEW_LOCAL_DOCKER=0', () => {
    expect(
      deriveLocalDockerPreviewSubdomainBase('http://hub.local', {
        AGENT_HUB_PREVIEW_LOCAL_DOCKER: '0',
      }),
    ).toBeNull();
  });
});

describe('previewRoutingBlockReason', () => {
  it('allows direct and subdomain routing', () => {
    expect(previewRoutingBlockReason({ publicUrl: null, subdomainBase: null }, {})).toBeNull();
    expect(
      previewRoutingBlockReason({ publicUrl: 'http://hub.local', subdomainBase: null }, {}),
    ).toBeNull();
    expect(
      previewRoutingBlockReason(
        { publicUrl: 'https://hub.example.com', subdomainBase: 'preview.hub.example.com' },
        {},
      ),
    ).toBeNull();
  });

  it('blocks path-prefix routing with an actionable message', () => {
    // The regression this guards: the wildcard cert was destroyed by a
    // Terraform apply and every project silently fell back to a static,
    // no-hot-reload preview. Nothing surfaced the misconfiguration, so it
    // read as "previews are broken" for weeks.
    const reason = previewRoutingBlockReason(
      { publicUrl: 'https://hub.example.com', subdomainBase: null },
      {},
    );
    expect(reason).toBe(PATH_PREFIX_PREVIEW_ERROR);
    expect(reason).toContain('AGENT_HUB_PREVIEW_SUBDOMAIN_BASE');
    expect(reason).toContain('RUNBOOK-subdomain-preview-hmr.md');
  });

  it('honours the operator opt-back-in', () => {
    const routing = { publicUrl: 'https://hub.example.com', subdomainBase: null };
    expect(
      previewRoutingBlockReason(routing, { AGENT_HUB_PREVIEW_ALLOW_PATH_PREFIX: '1' }),
    ).toBeNull();
    expect(
      previewRoutingBlockReason(routing, { AGENT_HUB_PREVIEW_ALLOW_PATH_PREFIX: 'true' }),
    ).toBeNull();
    // Anything else is not an opt-in — a stray value must not silently
    // re-enable the broken mode.
    expect(previewRoutingBlockReason(routing, { AGENT_HUB_PREVIEW_ALLOW_PATH_PREFIX: '0' })).toBe(
      PATH_PREFIX_PREVIEW_ERROR,
    );
    expect(previewRoutingBlockReason(routing, { AGENT_HUB_PREVIEW_ALLOW_PATH_PREFIX: 'yes' })).toBe(
      PATH_PREFIX_PREVIEW_ERROR,
    );
  });
});

describe('pathPrefixPreviewsAllowed', () => {
  it('defaults to false', () => {
    expect(pathPrefixPreviewsAllowed({})).toBe(false);
  });
});
