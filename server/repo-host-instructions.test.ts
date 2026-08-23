import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulePath = path.join(repoRoot, '.cursor', 'rules', 'git-hosted-on-agent-hub.mdc');

describe('local Agent Hub PR instructions', () => {
  it('derives credential lookup and API origin from the checkout origin', () => {
    const rule = readFileSync(rulePath, 'utf8');
    const localCheckout = rule.slice(rule.indexOf('From a local checkout'));

    expect(localCheckout).toContain('git remote get-url origin');
    expect(localCheckout).toContain('printf \'url=%s\\n\\n\' "$origin_url" | git credential fill');
    expect(localCheckout).toContain('new URL(process.argv[1]).origin');
    expect(localCheckout).not.toMatch(/export AGENT_HUB_URL="https?:\/\//);
  });
});
