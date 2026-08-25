import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BrandLogo from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the full lockup by default', () => {
    render(<BrandLogo />);
    const img = screen.getByTestId('brand-logo');
    expect(img).toHaveAttribute('src', '/logo.png?v=4');
    expect(img).toHaveAttribute('alt', 'Agent Hub');
  });

  it('renders the square mark when variant is mark', () => {
    render(<BrandLogo variant="mark" />);
    const img = screen.getByTestId('brand-logo-mark');
    expect(img).toHaveAttribute('src', '/logo-mark.png?v=4');
    expect(img).toHaveAttribute('alt', 'Agent Hub');
  });

  it('omits a name when alt is empty so adjacent Hub labels are not duplicated', () => {
    render(<BrandLogo variant="mark" size="xs" alt="" />);
    expect(screen.getByTestId('brand-logo-mark')).toHaveAttribute('alt', '');
  });
});

describe('brand mark vector (favicon.svg)', () => {
  // vitest runs with cwd at the client package root; fall back to the
  // repo-root-relative path in case it is invoked from elsewhere.
  const faviconPath = [
    resolve(process.cwd(), 'public/favicon.svg'),
    resolve(process.cwd(), 'client/public/favicon.svg'),
  ].find(existsSync);
  const svg = readFileSync(faviconPath as string, 'utf8');

  // Regression: every spoke must originate at the hub center (256,256) so it
  // reads as connected to the hub, not grazing/detached. The new mark draws the
  // round-cap spokes as <line> elements; all must share the hub-center origin.
  it('starts all round-cap spokes at the hub center (256,256)', () => {
    const lines = [...svg.matchAll(/<line [^>]*>/g)].map((m) => m[0]);
    expect(lines.length, 'spoke lines not found in favicon.svg').toBe(3);
    for (const line of lines) {
      expect(line).toMatch(/x1="256"\s+y1="256"/);
    }
  });

  // The hub is now a small hexagon (echoing the outer frame) rather than a
  // circle, centered on (256,256): its polygon spans the top/bottom vertices
  // 256,210 and 256,302 (mean y = 256) with no <circle> hub remaining.
  it('keeps the hexagon hub centered at (256,256) and drops the circle', () => {
    expect(svg).not.toContain('<circle');
    expect(svg).toContain('256,210');
    expect(svg).toContain('256,302');
  });
});
