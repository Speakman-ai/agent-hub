import { describe, expect, it } from 'vitest';
import {
  PATH_PREFIX_PREVIEW_ERROR,
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
});

describe('previewRoutingBlockReason', () => {
  it('allows direct and subdomain routing', () => {
    expect(previewRoutingBlockReason({ publicUrl: null, subdomainBase: null }, {})).toBeNull();
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
