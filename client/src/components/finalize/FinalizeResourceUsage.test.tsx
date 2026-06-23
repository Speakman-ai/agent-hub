/**
 * Tests for <FinalizeResourceUsage />.
 *
 * Guards the named `api` import (a default import links to `undefined` and
 * crashes the bundle, since utils/api.js only exports the named `api`) and the
 * render contract: nothing when no runner reported a summary, an aggregate line
 * plus a per-job breakdown when it did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FinalizeResourceUsage from './FinalizeResourceUsage';
import { api } from '../../utils/api';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    getFinalizeRunResources: vi.fn(),
  },
}));

const GB = 1024 * 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FinalizeResourceUsage', () => {
  it('renders nothing when no runner reported a summary', async () => {
    (api.getFinalizeRunResources as any).mockResolvedValue({ jobs: [] });
    const { container } = render(<FinalizeResourceUsage projectId="p1" runId="r1" />);
    await waitFor(() => expect(api.getFinalizeRunResources).toHaveBeenCalled());
    expect(container!.querySelector('[data-testid="finalize-resource-usage"]')).toBeNull();
  });

  it('renders the aggregate line and a per-job breakdown', async () => {
    (api.getFinalizeRunResources as any).mockResolvedValue({
      jobs: [
        {
          job_name: 'unit',
          matrix_key: 'default',
          peak_mem_bytes: 1.7 * GB,
          mem_total_bytes: 32 * GB,
          peak_cpu_percent: 40,
        },
        {
          job_name: 'e2e',
          matrix_key: 'shard-1',
          peak_mem_bytes: 4.2 * GB,
          mem_total_bytes: 32 * GB,
          peak_cpu_percent: 88,
        },
      ],
    });
    render(<FinalizeResourceUsage projectId="p1" runId="r1" />);
    expect(await screen.findByTestId('finalize-resource-usage')).toBeInTheDocument();
    // Aggregate: max peak mem (4.2) of total, max peak CPU (88%).
    expect(screen.getByTestId('finalize-resource-usage')).toHaveTextContent('4.2 / 32.0');
    expect(screen.getByTestId('finalize-resource-usage')).toHaveTextContent('88%');
    // Per-job breakdown shows each job name.
    expect(screen.getByText('unit')).toBeInTheDocument();
    expect(screen.getByText('e2e')).toBeInTheDocument();
  });
});
