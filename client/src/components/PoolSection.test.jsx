import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PoolSection, { Sparkline } from './PoolSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getPoolMetrics: vi.fn(),
    getPoolAlerts: vi.fn(),
  },
}));

const sampleSeries = [
  {
    id: 1,
    timestamp: '2026-04-20 12:00:00',
    pool_util: 0.5,
    queue_depth: 2,
    queue_depth_pr_env: 1,
    queue_depth_scaffold: 1,
    evictions: 0,
    reaps: 0,
    cert_days_remaining: 30,
  },
  {
    id: 2,
    timestamp: '2026-04-20 12:01:00',
    pool_util: 0.95,
    queue_depth: 7,
    queue_depth_pr_env: 5,
    queue_depth_scaffold: 2,
    evictions: 1,
    reaps: 0,
    cert_days_remaining: 10,
  },
];

beforeEach(() => {
  api.getPoolMetrics.mockResolvedValue({ windowHours: 24, samples: sampleSeries });
  api.getPoolAlerts.mockResolvedValue({ status: 'active', alerts: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<PoolSection />', () => {
  it('renders the latest snapshot tiles from the most recent sample', async () => {
    render(<PoolSection />);
    await waitFor(() => expect(api.getPoolMetrics).toHaveBeenCalledWith(24));

    // Pool util "95%" appears in both the tile and the sparkline header — both are valid renderings.
    const utilMatches = await screen.findAllByText('95%');
    expect(utilMatches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('7')).toBeInTheDocument(); // queue depth latest
    expect(screen.getByText(/pr_env=5/)).toBeInTheDocument();
    expect(screen.getByText('10.0')).toBeInTheDocument(); // cert days latest
  });

  it('shows the "no active alerts" banner when alerts is empty', async () => {
    render(<PoolSection />);
    expect(await screen.findByText(/No active pool alerts/i)).toBeInTheDocument();
  });

  it('renders active alerts with their type-specific label and severity tone', async () => {
    api.getPoolAlerts.mockResolvedValue({
      status: 'active',
      alerts: [
        {
          id: 1,
          alert_type: 'pool_util_high',
          severity: 'critical',
          message: 'pool_util > 90% sustained',
          fired_at: '2026-04-20 12:00:00',
          resolved_at: null,
          value: 0.95,
        },
        {
          id: 2,
          alert_type: 'cert_expiring',
          severity: 'critical',
          message: 'wildcard cert expires in 7d',
          fired_at: '2026-04-20 12:00:00',
          resolved_at: null,
          value: 7,
        },
      ],
    });

    render(<PoolSection />);
    expect(await screen.findByText(/Pool utilization sustained > 90%/i)).toBeInTheDocument();
    expect(screen.getByText(/Wildcard cert expiring soon/i)).toBeInTheDocument();
    expect(screen.queryByText(/No active pool alerts/i)).not.toBeInTheDocument();
  });

  it('refetches metrics with the new window when the window selector changes', async () => {
    render(<PoolSection />);
    await waitFor(() => expect(api.getPoolMetrics).toHaveBeenCalledWith(24));

    fireEvent.change(screen.getByLabelText(/Time window/i), { target: { value: '6' } });

    await waitFor(() => expect(api.getPoolMetrics).toHaveBeenCalledWith(6));
  });

  it('shows an error banner when the metrics endpoint rejects', async () => {
    api.getPoolMetrics.mockRejectedValueOnce(new Error('boom'));
    render(<PoolSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});

describe('<Sparkline />', () => {
  it('renders a placeholder svg when given no data', () => {
    const { container } = render(<Sparkline values={[]} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-label', 'No data');
  });

  it('renders a path with one M and N-1 L commands for N values', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4]} />);
    const paths = container.querySelectorAll('path');
    // First path is the area fill, second is the stroke line.
    expect(paths.length).toBeGreaterThanOrEqual(2);
    const stroke = paths[1].getAttribute('d') || '';
    const mCount = (stroke.match(/M/g) || []).length;
    const lCount = (stroke.match(/L/g) || []).length;
    expect(mCount).toBe(1);
    expect(lCount).toBe(3);
  });

  it('renders a warning threshold line when warnAt is provided', () => {
    const { container } = render(<Sparkline values={[10, 20, 30]} warnAt={25} />);
    expect(container.querySelector('line')).toBeInTheDocument();
  });
});
