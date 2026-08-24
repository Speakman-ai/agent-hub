import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BrandLogo from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the full lockup by default', () => {
    render(<BrandLogo />);
    const img = screen.getByTestId('brand-logo');
    expect(img).toHaveAttribute('src', '/logo.png?v=3');
    expect(img).toHaveAttribute('alt', 'Agent Hub');
  });

  it('renders the square mark when variant is mark', () => {
    render(<BrandLogo variant="mark" />);
    const img = screen.getByTestId('brand-logo-mark');
    expect(img).toHaveAttribute('src', '/logo-mark.png?v=3');
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

  // Regression: the top spoke used to start at (32,26) — the top of the r=6
  // hub circle centered at (32,32) — and head up-right, so it only grazed the
  // circle and read as disconnected. Its start must sit at the hub center so
  // it connects like the other two spokes.
  it('starts the top spoke at the hub center, not the circle edge', () => {
    const spokes = svg.match(/<path d="(m32 [^"]*)"/);
    expect(spokes, 'spoke path not found in favicon.svg').not.toBeNull();
    const d = spokes![1];
    expect(d.startsWith('m32 32')).toBe(true);
    expect(d.startsWith('m32 26')).toBe(false);
  });

  it('keeps the hub circle centered at (32,32)', () => {
    expect(svg).toMatch(/<circle cx="32" cy="32" r="6"/);
  });
});
