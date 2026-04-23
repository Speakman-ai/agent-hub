import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AuditReport from './AuditReport.jsx';
import { normalizeReport } from '../utils/auditReport.js';

describe('AuditReport', () => {
  it('renders empty placeholder when report is null', () => {
    render(<AuditReport report={null} />);
    expect(screen.getByTestId('audit-report-empty')).toBeInTheDocument();
  });

  it('renders score and band for a green report', () => {
    const r = normalizeReport({
      projectId: 'p1',
      categories: [
        { id: 'lint', status: 'ok' },
        { id: 'tests', status: 'ok' },
      ],
    });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-score-value').textContent).toBe('100');
    const band = screen.getByTestId('audit-score-band');
    expect(band.textContent).toBe('Ready');
    expect(screen.getByTestId('audit-report').getAttribute('data-score-band')).toBe('green');
  });

  it('renders amber band for middling score', () => {
    const r = normalizeReport({ score: 65, categories: [] });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-score-band').textContent).toBe('Needs work');
    expect(screen.getByTestId('audit-report').getAttribute('data-score-band')).toBe('amber');
  });

  it('renders red band for failing score', () => {
    const r = normalizeReport({ score: 20, categories: [] });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-score-band').textContent).toBe('Not ready');
    expect(screen.getByTestId('audit-report').getAttribute('data-score-band')).toBe('red');
  });

  it('renders em-dash when score is null', () => {
    const r = normalizeReport({ categories: [] });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-score-value').textContent).toBe('—');
  });

  it('lists each category with its status', () => {
    const r = normalizeReport({
      categories: [
        { id: 'lint', status: 'ok', summary: 'No lint errors' },
        { id: 'tests', status: 'fail', summary: '3 tests failing' },
        { id: 'aws', status: 'na' },
      ],
    });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-cat-lint').getAttribute('data-status')).toBe('ok');
    expect(screen.getByTestId('audit-cat-tests').getAttribute('data-status')).toBe('fail');
    expect(screen.getByTestId('audit-cat-aws').getAttribute('data-status')).toBe('na');
    expect(screen.getByText('No lint errors')).toBeInTheDocument();
  });

  it('shows a severity badge on a category when findings reference it', () => {
    const r = normalizeReport({
      categories: [{ id: 'tests', status: 'fail' }],
      findings: [
        { severity: 'error', category: 'tests', message: 'x failed' },
        { severity: 'warn', category: 'tests', message: 'y flaky' },
      ],
    });
    render(<AuditReport report={r} />);
    const badge = screen.getByTestId('audit-cat-tests-badge');
    expect(badge.textContent).toContain('2');
    expect(badge.textContent.toLowerCase()).toContain('error');
  });

  it('renders the findings list when findings exist', () => {
    const r = normalizeReport({
      categories: [],
      findings: [
        {
          id: 'f1',
          severity: 'warn',
          message: 'TypeScript strict mode off',
          hint: 'Turn on strict',
        },
      ],
    });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-findings')).toBeInTheDocument();
    expect(screen.getByTestId('audit-finding-f1')).toBeInTheDocument();
    expect(screen.getByText(/TypeScript strict mode off/)).toBeInTheDocument();
    expect(screen.getByText(/Turn on strict/)).toBeInTheDocument();
  });

  it('omits the findings section when no findings', () => {
    const r = normalizeReport({ categories: [] });
    render(<AuditReport report={r} />);
    expect(screen.queryByTestId('audit-findings')).not.toBeInTheDocument();
  });

  it('renders gaps when present', () => {
    const r = normalizeReport({
      categories: [],
      gaps: [{ id: 'g-deploy', label: 'No deploy pipeline', hint: 'Add GitHub Actions' }],
    });
    render(<AuditReport report={r} />);
    expect(screen.getByTestId('audit-gap-g-deploy')).toBeInTheDocument();
    expect(screen.getByText(/No deploy pipeline/)).toBeInTheDocument();
  });

  it('calls onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn();
    const r = normalizeReport({ categories: [] });
    render(<AuditReport report={r} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('audit-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not render refresh when no callback provided', () => {
    const r = normalizeReport({ categories: [] });
    render(<AuditReport report={r} />);
    expect(screen.queryByTestId('audit-refresh')).not.toBeInTheDocument();
  });
});
