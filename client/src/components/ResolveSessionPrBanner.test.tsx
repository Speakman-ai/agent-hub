import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ResolveSessionPrBanner from './ResolveSessionPrBanner';

describe('ResolveSessionPrBanner', () => {
  it('links out to GitHub for a github.com PR URL', () => {
    render(
      <ResolveSessionPrBanner prUrl="https://github.com/acme/app/pull/42" prNumber="42" />, //
    );
    const link = screen.getByTestId('resolve-pr-banner-link');
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/42');
    expect(link).toHaveTextContent('Open PR on GitHub');
    expect(screen.getByText(/Open the PR on GitHub/)).toBeInTheDocument();
  });

  // Regression: a Hub-hosted project's `[Resolve PR #N]` session was linking to
  // github.com/<mirror-repo>/pull/N, which is a different (or missing) PR.
  it('opens the in-app PR detail for an Agent Hub-native PR URL', () => {
    const onOpenPrDetail = vi.fn();
    render(
      <ResolveSessionPrBanner
        prUrl="/projects/acme-widgets/pulls/587"
        prNumber="587"
        onOpenPrDetail={onOpenPrDetail}
      />,
    );
    const link = screen.getByTestId('resolve-pr-banner-link');
    expect(link).not.toHaveAttribute('href');
    expect(link).toHaveTextContent('Open PR on Agent Hub');
    expect(screen.getByText(/Open the PR on Agent Hub/)).toBeInTheDocument();

    fireEvent.click(link);
    expect(onOpenPrDetail).toHaveBeenCalledWith('acme-widgets', 587);
  });

  it('never renders an outbound link for a native PR without a navigation handler', () => {
    render(<ResolveSessionPrBanner prUrl="/projects/acme-widgets/pulls/587" prNumber="587" />);
    expect(screen.queryByTestId('resolve-pr-banner-link')).toBeNull();
  });

  it('renders no link at all when the PR URL is unknown', () => {
    render(<ResolveSessionPrBanner prUrl={null} prNumber="9" />);
    expect(screen.queryByTestId('resolve-pr-banner-link')).toBeNull();
    expect(screen.getByText(/Set the project’s repository in settings/)).toBeInTheDocument();
  });

  it('calls onDismiss with the session id', () => {
    const onDismiss = vi.fn();
    render(
      <ResolveSessionPrBanner prUrl={null} prNumber="9" sessionId="s1" onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('s1');
  });
});
