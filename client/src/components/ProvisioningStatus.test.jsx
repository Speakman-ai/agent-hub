import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProvisioningStatus from './ProvisioningStatus.jsx';

function phase(id, status, at = '2026-04-23T00:00:00Z', extra = {}) {
  return { type: 'phase', phase: id, status, at, ...extra };
}
function log(line, at = '2026-04-23T00:00:00Z') {
  return { type: 'log', line, at };
}

describe('ProvisioningStatus', () => {
  describe('idle / initial render', () => {
    it('renders every phase as pending with "Waiting to start" overall status', () => {
      render(<ProvisioningStatus events={[]} />);
      expect(screen.getByTestId('provisioning-status')).toBeInTheDocument();
      expect(screen.getByTestId('ps-overall')).toHaveTextContent(/Waiting to start/);
      const row = screen.getByTestId('ps-phase-validate');
      expect(row).toHaveAttribute('data-status', 'pending');
      expect(row).toHaveAttribute('data-tone', 'grey');
    });

    it('drops gh-* phases when withGithub is false', () => {
      render(<ProvisioningStatus events={[]} withGithub={false} />);
      expect(screen.queryByTestId('ps-phase-gh-create')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ps-phase-gh-push')).not.toBeInTheDocument();
      // Non-gh phases still render
      expect(screen.getByTestId('ps-phase-copy-template')).toBeInTheDocument();
    });
  });

  describe('running state', () => {
    it('shows the running phase as amber and overall as "Provisioning…"', () => {
      render(<ProvisioningStatus events={[phase('validate', 'started')]} />);
      expect(screen.getByTestId('ps-overall')).toHaveTextContent(/Provisioning/);
      expect(screen.getByTestId('ps-phase-validate')).toHaveAttribute('data-tone', 'amber');
    });

    it('transitions a phase from amber → green on ok', () => {
      const events = [phase('validate', 'started'), phase('validate', 'ok')];
      render(<ProvisioningStatus events={events} />);
      const row = screen.getByTestId('ps-phase-validate');
      expect(row).toHaveAttribute('data-tone', 'green');
      expect(row).toHaveAttribute('data-status', 'ok');
    });
  });

  describe('log tail', () => {
    it('renders empty-state text when no logs are present', () => {
      render(<ProvisioningStatus events={[]} />);
      expect(screen.getByTestId('ps-log-body')).toHaveTextContent(/Waiting for output/);
    });

    it('renders log lines in order', () => {
      const events = [log('first'), log('second'), log('third')];
      render(<ProvisioningStatus events={events} />);
      const body = screen.getByTestId('ps-log-body');
      expect(body).toHaveTextContent(/first/);
      expect(body).toHaveTextContent(/second/);
      expect(body).toHaveTextContent(/third/);
    });

    it('collapses when toggled and hides the body', () => {
      render(<ProvisioningStatus events={[log('hello')]} />);
      expect(screen.getByTestId('ps-log-body')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('ps-log-toggle'));
      expect(screen.queryByTestId('ps-log-body')).not.toBeInTheDocument();
    });
  });

  describe('terminal states', () => {
    it('success → renders the success card with the repo link', () => {
      const events = [
        phase('validate', 'ok'),
        phase('gh-push', 'ok'),
        { type: 'done', repoUrl: 'https://github.com/acme/x' },
      ];
      render(<ProvisioningStatus events={events} />);
      expect(screen.getByTestId('ps-overall')).toHaveTextContent(/Project ready/);
      const link = screen.getByTestId('ps-repo-link');
      expect(link).toHaveAttribute('href', 'https://github.com/acme/x');
    });

    it('partial → renders the amber partial card with an actionable hint', () => {
      const events = [
        phase('validate', 'ok'),
        phase('gh-push', 'failed'),
        {
          type: 'done',
          partial: true,
          error: { code: 5, message: 'gh push failed' },
        },
      ];
      render(<ProvisioningStatus events={events} />);
      expect(screen.getByTestId('ps-overall')).toHaveTextContent(/GitHub step failed/);
      const card = screen.getByTestId('ps-partial');
      expect(card).toHaveTextContent(/Hint:/);
      expect(card).toHaveTextContent(/administration: write|owner/i);
    });

    it('failed → renders the red failure card with message + hint + exit code', () => {
      const events = [
        phase('copy-template', 'failed'),
        { type: 'done', error: { code: 3, message: 'template copy failed' } },
      ];
      render(<ProvisioningStatus events={events} />);
      const card = screen.getByTestId('ps-failure');
      expect(card).toHaveTextContent(/template copy failed/);
      expect(card).toHaveTextContent(/exit 3/);
      expect(card).toHaveTextContent(/Hint:/);
    });

    it('failure card wires onRetry and onClose callbacks', () => {
      const onRetry = vi.fn();
      const onClose = vi.fn();
      const events = [{ type: 'done', error: { code: 3, message: 'x' } }];
      render(<ProvisioningStatus events={events} onRetry={onRetry} onClose={onClose} />);
      fireEvent.click(screen.getByTestId('ps-retry'));
      fireEvent.click(screen.getByTestId('ps-failure-close'));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('success card wires onClose and onOpenRepo', () => {
      const onClose = vi.fn();
      const onOpenRepo = vi.fn();
      const events = [{ type: 'done', repoUrl: 'https://github.com/acme/x' }];
      render(<ProvisioningStatus events={events} onClose={onClose} onOpenRepo={onOpenRepo} />);
      fireEvent.click(screen.getByTestId('ps-success-close'));
      fireEvent.click(screen.getByTestId('ps-repo-link'));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onOpenRepo).toHaveBeenCalledWith('https://github.com/acme/x');
    });
  });

  describe('phase order and gh gating', () => {
    it('renders phases in the canonical order', () => {
      render(<ProvisioningStatus events={[]} />);
      const list = screen.getByTestId('ps-phases').querySelectorAll('[data-testid^="ps-phase-"]');
      const ids = Array.from(list).map((el) => el.getAttribute('data-testid'));
      expect(ids[0]).toBe('ps-phase-validate');
      expect(ids[ids.length - 1]).toBe('ps-phase-gh-push');
    });
  });
});
