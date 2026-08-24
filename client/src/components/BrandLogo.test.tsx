import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BrandLogo from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the full lockup by default', () => {
    render(<BrandLogo />);
    const img = screen.getByTestId('brand-logo');
    expect(img).toHaveAttribute('src', '/logo.png?v=2');
    expect(img).toHaveAttribute('alt', 'Agent Hub');
  });

  it('renders the square mark when variant is mark', () => {
    render(<BrandLogo variant="mark" />);
    const img = screen.getByTestId('brand-logo-mark');
    expect(img).toHaveAttribute('src', '/logo-mark.png?v=2');
    expect(img).toHaveAttribute('alt', 'Agent Hub');
  });

  it('omits a name when alt is empty so adjacent Hub labels are not duplicated', () => {
    render(<BrandLogo variant="mark" size="xs" alt="" />);
    expect(screen.getByTestId('brand-logo-mark')).toHaveAttribute('alt', '');
  });
});
