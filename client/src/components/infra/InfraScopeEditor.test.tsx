import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InfraScopeEditor, {
  completeRows,
  incompleteRows,
  toProjectionScopes,
  toSavePayload,
  toTagFilter,
  toDraftRow,
} from './InfraScopeEditor';
import { api } from '../../utils/api';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    getInfraScopes: vi.fn(),
    updateInfraScopes: vi.fn(),
    projectInfraCost: vi.fn(),
  },
}));

const getInfraScopes = vi.mocked(api.getInfraScopes);
const updateInfraScopes = vi.mocked(api.updateInfraScopes);
const projectInfraCost = vi.mocked(api.projectInfraCost);

function scopesResponse(overrides: Record<string, any> = {}) {
  return {
    scopes: [],
    projection: { metricsRequestedPerMonth: 0, estimatedMonthlyCostUsd: 0, perScope: [] },
    collectableServices: ['ec2', 'rds'],
    uncollectableServices: [],
    monthlyCeilingUsd: null,
    degradation: 'normal',
    maxScopes: 200,
    configured: false,
    ...overrides,
  } as any;
}

const storedScope = {
  id: 'scope-1',
  projectId: 'project-1',
  profileName: 'monitoring',
  accountId: '111122223333',
  region: 'us-east-2',
  service: 'ec2',
  tagFilter: { Environment: ['prod', 'staging'] },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  resourceCount: 12,
};

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: `clear` empties recorded calls but leaves
  // queued `mockReturnValueOnce` values in place, so a test whose once-value is
  // never consumed hands it to the next test and makes the suite order-dependent.
  vi.resetAllMocks();
  vi.useRealTimers();
  getInfraScopes.mockResolvedValue(scopesResponse());
  projectInfraCost.mockResolvedValue({
    metricsRequestedPerMonth: 1000,
    estimatedMonthlyCostUsd: 12.34,
    perScope: [],
  } as any);
  updateInfraScopes.mockResolvedValue(scopesResponse());
});

describe('pure helpers', () => {
  it('drops half-typed tag clauses rather than sending a filter the server rejects', () => {
    expect(toTagFilter([{ key: 'Env', values: 'prod, staging' }])).toEqual({
      Env: ['prod', 'staging'],
    });
    expect(toTagFilter([{ key: '  ', values: 'prod' }])).toBeNull();
    expect(toTagFilter([{ key: 'Env', values: '  ,  ' }])).toBeNull();
    expect(toTagFilter([])).toBeNull();
  });

  it('treats a row missing any part of the triple as incomplete', () => {
    const rows = [
      {
        key: 'a',
        profileName: 'm',
        region: 'us-east-2',
        service: 'ec2',
        enabled: true,
        resourceCount: 1,
        tagClauses: [],
      },
      {
        key: 'b',
        profileName: '',
        region: 'us-east-2',
        service: 'ec2',
        enabled: true,
        resourceCount: 1,
        tagClauses: [],
      },
      {
        key: 'c',
        profileName: 'm',
        region: '',
        service: 'ec2',
        enabled: true,
        resourceCount: 1,
        tagClauses: [],
      },
    ];
    expect(completeRows(rows).map((r) => r.key)).toEqual(['a']);
  });

  it('omits paused rows from the price, because a paused scope issues no requests', () => {
    const rows = [
      {
        key: 'a',
        profileName: 'm',
        region: 'us-east-2',
        service: 'EC2',
        enabled: true,
        resourceCount: 5,
        tagClauses: [],
      },
      {
        key: 'b',
        profileName: 'm',
        region: 'us-east-2',
        service: 'rds',
        enabled: false,
        resourceCount: 9,
        tagClauses: [],
      },
    ];
    expect(toProjectionScopes(rows)).toEqual([
      { id: undefined, service: 'ec2', region: 'us-east-2', profileName: 'm', resourceCount: 5 },
    ]);
  });

  it('keeps paused rows in the save payload and leaves the estimate out of it', () => {
    const rows = [
      {
        key: 'b',
        profileName: 'm',
        region: 'us-east-2',
        service: 'RDS',
        enabled: false,
        resourceCount: 9,
        tagClauses: [{ key: 'Env', values: 'prod' }],
      },
    ];
    const payload = toSavePayload(rows);
    expect(payload).toEqual([
      {
        profileName: 'm',
        region: 'us-east-2',
        service: 'rds',
        enabled: false,
        tagFilter: { Env: ['prod'] },
      },
    ]);
    expect(payload[0]).not.toHaveProperty('resourceCount');
  });

  it('round-trips a stored tag filter into editable text', () => {
    expect(toDraftRow(storedScope).tagClauses).toEqual([
      { key: 'Environment', values: 'prod, staging' },
    ]);
    expect(toDraftRow({ ...storedScope, tagFilter: null }).tagClauses).toEqual([]);
  });

  it('merges duplicate tag keys instead of letting the last clause win', () => {
    // Values within a tag are ORed, so two clauses on one key are two halves of
    // one filter. Overwriting would save something narrower than was entered.
    expect(
      toTagFilter([
        { key: 'Env', values: 'prod' },
        { key: 'Env', values: 'staging, qa' },
        { key: 'Team', values: 'core' },
      ]),
    ).toEqual({ Env: ['prod', 'staging', 'qa'], Team: ['core'] });
  });

  it('dedupes a value repeated across clauses', () => {
    expect(
      toTagFilter([
        { key: 'Env', values: 'prod, staging' },
        { key: ' Env ', values: 'prod' },
      ]),
    ).toEqual({ Env: ['prod', 'staging'] });
  });

  it('reports rows missing any part of the triple', () => {
    const rows = [
      {
        key: 'a',
        profileName: 'm',
        region: 'us-east-2',
        service: 'ec2',
        enabled: true,
        resourceCount: 1,
        tagClauses: [],
      },
      {
        key: 'b',
        profileName: '  ',
        region: 'us-east-2',
        service: 'ec2',
        enabled: true,
        resourceCount: 1,
        tagClauses: [],
      },
    ];
    expect(incompleteRows(rows).map((r) => r.key)).toEqual(['b']);
  });
});

describe('InfraScopeEditor', () => {
  it('renders stored scopes and the ceiling the project already has', async () => {
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope],
        monthlyCeilingUsd: 40,
        configured: true,
        projection: { metricsRequestedPerMonth: 500, estimatedMonthlyCostUsd: 3.5, perScope: [] },
      }),
    );

    render(<InfraScopeEditor projectId="project-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());
    expect(screen.getByLabelText('Profile')).toHaveValue('monitoring');
    expect(screen.getByLabelText('Region')).toHaveValue('us-east-2');
    expect(screen.getByLabelText('Service')).toHaveValue('ec2');
    expect(screen.getByLabelText('Resources')).toHaveValue(12);
    expect(screen.getByLabelText('Monthly cost ceiling (USD)')).toHaveValue('40');
    expect(screen.getByLabelText('Tag values')).toHaveValue('prod, staging');
  });

  it('says plainly that an empty list collects nothing', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());
    expect(screen.getByText(/No scopes yet. Nothing is being collected./)).toBeInTheDocument();
    expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$0.00');
  });

  it('reprices as rows change, before anything is saved', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'monitoring' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east-2' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'ec2' } });
    fireEvent.change(screen.getByLabelText('Resources'), { target: { value: '50' } });

    await waitFor(() =>
      expect(projectInfraCost).toHaveBeenCalledWith('project-1', {
        scopes: [
          {
            id: undefined,
            service: 'ec2',
            region: 'us-east-2',
            profileName: 'monitoring',
            resourceCount: 50,
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$12.34'),
    );

    // Pricing is what the endpoint is for; it must not have persisted anything.
    expect(updateInfraScopes).not.toHaveBeenCalled();
  });

  it('reprices downward when a row is removed', async () => {
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope],
        configured: true,
        projection: { metricsRequestedPerMonth: 500, estimatedMonthlyCostUsd: 3.5, perScope: [] },
      }),
    );
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$3.50'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove scope' }));

    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$0.00'),
    );
    expect(screen.getByText(/Nothing is being collected/)).toBeInTheDocument();
  });

  it('drops a paused row out of the projection without deleting it', async () => {
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope],
        configured: true,
        projection: { metricsRequestedPerMonth: 500, estimatedMonthlyCostUsd: 3.5, perScope: [] },
      }),
    );
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByLabelText('Enabled')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Enabled'));

    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$0.00'),
    );
    expect(screen.getByTestId('infra-scope-row')).toBeInTheDocument();
  });

  it('never renders a real cost as $0.00', async () => {
    projectInfraCost.mockResolvedValue({
      metricsRequestedPerMonth: 40,
      estimatedMonthlyCostUsd: 0.004,
      perScope: [],
    } as any);
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));

    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('<$0.01'),
    );
  });

  it('saves the list and the ceiling in one request and adopts the response', async () => {
    updateInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [{ ...storedScope, tagFilter: null, resourceCount: 0 }],
        monthlyCeilingUsd: 25,
        configured: true,
      }),
    );
    const showToast = vi.fn();
    render(<InfraScopeEditor projectId="project-1" showToast={showToast} />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'monitoring' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east-2' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'ec2' } });
    fireEvent.change(screen.getByLabelText('Monthly cost ceiling (USD)'), {
      target: { value: '25' },
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));

    await waitFor(() =>
      expect(updateInfraScopes).toHaveBeenCalledWith('project-1', {
        scopes: [
          {
            profileName: 'monitoring',
            region: 'us-east-2',
            service: 'ec2',
            enabled: true,
            tagFilter: null,
          },
        ],
        monthlyCeilingUsd: 25,
      }),
    );
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(showToast).toHaveBeenCalledWith('Collection scope saved', 'success');
  });

  it('sends a blank ceiling as null, meaning uncapped', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ monthlyCeilingUsd: 40 }));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByLabelText('Monthly cost ceiling (USD)')).toHaveValue('40'),
    );

    fireEvent.change(screen.getByLabelText('Monthly cost ceiling (USD)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));

    await waitFor(() =>
      expect(updateInfraScopes).toHaveBeenCalledWith('project-1', {
        scopes: [],
        monthlyCeilingUsd: null,
      }),
    );
  });

  it('saves an edited tag filter as the wire format', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByLabelText('Tag values')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Tag values'), { target: { value: 'prod' } });
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));

    await waitFor(() => expect(updateInfraScopes).toHaveBeenCalled());
    expect(updateInfraScopes.mock.calls[0]![1]).toMatchObject({
      scopes: [expect.objectContaining({ tagFilter: { Environment: ['prod'] } })],
    });
  });

  it('surfaces a server validation error instead of pretending the save worked', async () => {
    updateInfraScopes.mockRejectedValue(
      new Error('duplicate scope for monitoring / us-east-2 / ec2'),
    );
    const showToast = vi.fn();
    render(<InfraScopeEditor projectId="project-1" showToast={showToast} />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));

    await waitFor(() =>
      expect(screen.getByTestId('infra-scope-error')).toHaveTextContent('duplicate scope'),
    );
    expect(showToast).toHaveBeenCalledWith(
      'duplicate scope for monitoring / us-east-2 / ec2',
      'error',
    );
  });

  it('blocks the save on a duplicate triple and says which row is wrong', async () => {
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope, { ...storedScope, id: 'scope-2', service: 'rds' }],
        configured: true,
      }),
    );
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getAllByLabelText('Service')).toHaveLength(2));

    fireEvent.change(screen.getAllByLabelText('Service')[1]!, { target: { value: 'ec2' } });

    await waitFor(() => expect(screen.getAllByText(/Duplicate scope/).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    expect(updateInfraScopes).not.toHaveBeenCalled();
  });

  it('blocks the save on a negative ceiling', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Monthly cost ceiling (USD)'), {
      target: { value: '-5' },
    });

    expect(screen.getByText(/Enter a number of zero or more/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
  });

  it('explains the degradation behaviour next to the ceiling', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    expect(screen.getByText(/widens every poll interval fourfold/)).toBeInTheDocument();
    expect(screen.getByText(/stops issuing billed requests entirely/)).toBeInTheDocument();
  });

  it('warns when the projection already exceeds the ceiling being set', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$12.34'),
    );

    fireEvent.change(screen.getByLabelText('Monthly cost ceiling (USD)'), {
      target: { value: '5' },
    });
    expect(screen.getByTestId('infra-scope-over-ceiling')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Monthly cost ceiling (USD)'), {
      target: { value: '50' },
    });
    expect(screen.queryByTestId('infra-scope-over-ceiling')).not.toBeInTheDocument();
  });

  it('flags a service no metric pack collects, without blocking the save', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'monitoring' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east-2' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'quantumdb' } });

    expect(screen.getByText(/No metric pack collects/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );
  });

  it('refuses to save while a row is incomplete, instead of silently deleting it', async () => {
    // Regression: the save is a whole-list replace, so a row dropped from the
    // payload is a row deleted on the server. Blanking a field of a working
    // scope must not quietly stop it being collected.
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('monitoring'));

    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: '' } });

    expect(screen.getByTestId('infra-scope-incomplete')).toBeInTheDocument();
    expect(screen.getByTestId('infra-scope-save-blocked')).toHaveTextContent('1 row is incomplete');
    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    expect(updateInfraScopes).not.toHaveBeenCalled();
  });

  it('refuses to save a freshly added blank row rather than replacing with an empty list', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));

    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    expect(updateInfraScopes).not.toHaveBeenCalled();
  });

  it('re-enables the save once the row is completed', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'monitoring' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east-2' } });
    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'ec2' } });

    expect(screen.queryByTestId('infra-scope-incomplete')).not.toBeInTheDocument();
    // Still held until the newly completed draft has actually been priced.
    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );
  });

  it('does not claim an empty allowlist when the load failed', async () => {
    // Regression: an empty draft after a failed load means "unknown", not
    // "nothing is scoped" — the two read identically but mean opposite things.
    getInfraScopes.mockRejectedValue(new Error('scopes unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());
    expect(screen.queryByText(/No scopes yet/)).not.toBeInTheDocument();
    expect(screen.getByTestId('infra-scope-unknown')).toBeInTheDocument();
  });

  it('blocks the save after a failed load, so it cannot wipe the stored allowlist', async () => {
    getInfraScopes.mockRejectedValue(new Error('scopes unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    expect(updateInfraScopes).not.toHaveBeenCalled();
  });

  it('still reports a genuinely empty allowlist when the load succeeded', async () => {
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    expect(screen.getByText(/No scopes yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('infra-scope-unknown')).not.toBeInTheDocument();
    // Emptying the list on purpose remains a legitimate, saveable action.
    expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled();
  });

  it('keeps the draft saveable when it was the save that failed, not the load', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    updateInfraScopes.mockRejectedValue(new Error('server busy'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('monitoring'));

    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());

    // The rows on screen are still the ones the server gave us, so retrying is safe.
    expect(screen.getByLabelText('Profile')).toHaveValue('monitoring');
    expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled();
  });

  it('shows an unavailable price rather than $0.00 when pricing fails', async () => {
    // Regression: zeroing the projection made an unknown cost look free, which
    // invites approving an expensive allowlist.
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    projectInfraCost.mockRejectedValue(new Error('pricing unavailable'));

    render(<InfraScopeEditor projectId="project-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('infra-pricing-unavailable')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('infra-projected-cost')).not.toHaveTextContent('$0.00');
  });

  it('does not judge the ceiling against a price it could not compute', async () => {
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope],
        configured: true,
        projection: { metricsRequestedPerMonth: 500, estimatedMonthlyCostUsd: 90, perScope: [] },
      }),
    );
    projectInfraCost.mockRejectedValue(new Error('pricing unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('infra-pricing-unavailable')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('Monthly cost ceiling (USD)'), {
      target: { value: '5' },
    });

    expect(screen.queryByTestId('infra-scope-over-ceiling')).not.toBeInTheDocument();
  });

  it('recovers the price once a later pricing request succeeds', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    projectInfraCost.mockRejectedValueOnce(new Error('pricing unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('infra-pricing-unavailable')).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('Resources'), { target: { value: '7' } });

    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$12.34'),
    );
    expect(screen.queryByTestId('infra-pricing-unavailable')).not.toBeInTheDocument();
  });

  it('reports a real zero as $0.00, not as unavailable', async () => {
    projectInfraCost.mockRejectedValue(new Error('pricing unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());

    // Nothing enabled is genuinely nothing billed; no request is even issued.
    expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$0.00');
    expect(screen.queryByTestId('infra-pricing-unavailable')).not.toBeInTheDocument();
  });

  it('discards a save that settles after the project changed', async () => {
    // Regression: the old project's response repainted the new project's rows
    // and was reported upward as the new project's scopes.
    const onScopesChange = vi.fn();
    getInfraScopes
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }))
      .mockResolvedValueOnce(scopesResponse({ scopes: [], configured: false }));

    let releaseSave: (v: any) => void = () => {};
    updateInfraScopes.mockReturnValue(
      new Promise((resolve) => {
        releaseSave = resolve;
      }) as any,
    );
    const showToast = vi.fn();

    const { rerender } = render(
      <InfraScopeEditor
        projectId="project-a"
        showToast={showToast}
        onScopesChange={onScopesChange}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('monitoring'));

    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(updateInfraScopes).toHaveBeenCalled());

    rerender(
      <InfraScopeEditor
        projectId="project-b"
        showToast={showToast}
        onScopesChange={onScopesChange}
      />,
    );
    await waitFor(() => expect(getInfraScopes).toHaveBeenCalledWith('project-b'));

    onScopesChange.mockClear();
    releaseSave(scopesResponse({ scopes: [storedScope], configured: true }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );

    // project-a's rows must not appear in project-b's editor, and project-b's
    // parent must not be told they are its scopes.
    expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument();
    expect(onScopesChange).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith('Collection scope saved', 'success');
  });

  it('does not surface a save error belonging to a project that was switched away', async () => {
    getInfraScopes
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }))
      .mockResolvedValueOnce(scopesResponse({ scopes: [], configured: false }));

    let rejectSave: (e: any) => void = () => {};
    updateInfraScopes.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }) as any,
    );
    const showToast = vi.fn();

    const { rerender } = render(<InfraScopeEditor projectId="project-a" showToast={showToast} />);
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('monitoring'));
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(updateInfraScopes).toHaveBeenCalled());

    rerender(<InfraScopeEditor projectId="project-b" showToast={showToast} />);
    await waitFor(() => expect(getInfraScopes).toHaveBeenCalledWith('project-b'));

    rejectSave(new Error('server busy'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );

    expect(screen.queryByTestId('infra-scope-error')).not.toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalledWith('server busy', 'error');
  });

  it('will not let a stale price be approved for an edited allowlist', async () => {
    // Regression: the panel kept showing the previous, cheaper figure with only
    // a "Recalculating…" note while Save stayed live, so an operator could
    // approve an expensive list against a cheap number.
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope],
        configured: true,
        projection: { metricsRequestedPerMonth: 500, estimatedMonthlyCostUsd: 3.5, perScope: [] },
      }),
    );
    projectInfraCost.mockResolvedValue({
      metricsRequestedPerMonth: 90000,
      estimatedMonthlyCostUsd: 250,
      perScope: [],
    } as any);

    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$3.50'),
    );
    expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled();

    // Make the list dramatically more expensive.
    fireEvent.change(screen.getByLabelText('Resources'), { target: { value: '9000' } });

    // The cheap figure must be gone and the save held, not merely annotated.
    expect(screen.getByTestId('infra-projected-cost')).not.toHaveTextContent('$3.50');
    expect(screen.getByTestId('infra-pricing-stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save scope/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    expect(updateInfraScopes).not.toHaveBeenCalled();

    // Once priced, the real number appears and saving is allowed again.
    await waitFor(() =>
      expect(screen.getByTestId('infra-projected-cost')).toHaveTextContent('$250.00'),
    );
    expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled();
  });

  it('does not judge the ceiling against a price that is still being recomputed', async () => {
    getInfraScopes.mockResolvedValue(
      scopesResponse({
        scopes: [storedScope],
        monthlyCeilingUsd: 5,
        configured: true,
        projection: { metricsRequestedPerMonth: 500, estimatedMonthlyCostUsd: 90, perScope: [] },
      }),
    );
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-over-ceiling')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Resources'), { target: { value: '1' } });

    expect(screen.queryByTestId('infra-scope-over-ceiling')).not.toBeInTheDocument();
  });

  it('still allows saving when pricing failed, since waiting would not help', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    projectInfraCost.mockRejectedValue(new Error('pricing unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('monitoring'));

    fireEvent.change(screen.getByLabelText('Resources'), { target: { value: '20' } });

    await waitFor(() =>
      expect(screen.getByTestId('infra-pricing-unavailable')).toBeInTheDocument(),
    );
    // A failed price is settled, not pending: blocking here would trap an
    // operator out of removing scopes during a pricing outage.
    expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled();
  });

  it('freezes editing while a save is in flight, so the response cannot eat an edit', async () => {
    // Regression: the request captured the old rows, and applyResponse then
    // overwrote any edit made while it was in flight.
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    let releaseSave: (v: any) => void = () => {};
    updateInfraScopes.mockReturnValue(
      new Promise((resolve) => {
        releaseSave = resolve;
      }) as any,
    );

    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(updateInfraScopes).toHaveBeenCalled());

    expect(screen.getByLabelText('Profile')).toBeDisabled();
    expect(screen.getByLabelText('Region')).toBeDisabled();
    expect(screen.getByLabelText('Monthly cost ceiling (USD)')).toBeDisabled();
    expect(screen.getByLabelText('Remove scope')).toBeDisabled();

    // An attempted edit during the freeze is refused rather than accepted and
    // then silently discarded by the response.
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'other-profile' } });
    expect(screen.getByLabelText('Profile')).toHaveValue('monitoring');

    releaseSave(scopesResponse({ scopes: [storedScope], configured: true }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).not.toBeDisabled());
    expect(screen.getByLabelText('Profile')).toHaveValue('monitoring');
  });

  it('does not hand the next project a frozen editor when a save is still pending', async () => {
    // Regression: `saving` survived the switch, so project-b inherited
    // project-a's freeze. A hung request left it read-only indefinitely.
    getInfraScopes
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }))
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }));
    // project-a's save never settles.
    updateInfraScopes.mockReturnValue(new Promise(() => {}) as any);

    const { rerender } = render(<InfraScopeEditor projectId="project-a" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toBeDisabled());

    rerender(<InfraScopeEditor projectId="project-b" />);

    await waitFor(() => expect(screen.getByLabelText('Profile')).not.toBeDisabled());
    expect(screen.getByLabelText('Monthly cost ceiling (USD)')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'b-profile' } });
    expect(screen.getByLabelText('Profile')).toHaveValue('b-profile');
  });

  it('lets a stale save settle without unfreezing the new project mid-save', async () => {
    // The other direction of the same coupling: now that the switch clears the
    // freeze, project-a's late settle must not clear project-b's.
    getInfraScopes
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }))
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }));

    let releaseA: (v: any) => void = () => {};
    updateInfraScopes.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseA = resolve;
      }) as any,
    );
    updateInfraScopes.mockReturnValueOnce(new Promise(() => {}) as any);

    const { rerender } = render(<InfraScopeEditor projectId="project-a" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toBeDisabled());

    rerender(<InfraScopeEditor projectId="project-b" />);
    await waitFor(() => expect(screen.getByLabelText('Profile')).not.toBeDisabled());

    // project-b starts its own save, then project-a's finally fires.
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(screen.getByLabelText('Profile')).toBeDisabled());

    await act(async () => {
      releaseA(scopesResponse({ scopes: [storedScope], configured: true }));
      // Flushed inside act so project-a's continuation — including its
      // `finally` — has actually run before the assertion. A bare waitFor here
      // would pass on the first check, before the stale settle could unfreeze
      // anything, and would therefore assert nothing.
      await Promise.resolve();
      await Promise.resolve();
    });

    // project-b's freeze must hold: its own response is still coming, and
    // reopening the inputs now is exactly what loses an edit.
    expect(screen.getByLabelText('Profile')).toBeDisabled();
  });

  it('re-enables editing after a failed save so the draft can be retried', async () => {
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    updateInfraScopes.mockRejectedValue(new Error('server busy'));
    render(<InfraScopeEditor projectId="project-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save scope/ })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));
    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());

    expect(screen.getByLabelText('Profile')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'retry-profile' } });
    expect(screen.getByLabelText('Profile')).toHaveValue('retry-profile');
  });

  it('reports a load failure rather than rendering an empty list as "nothing scoped"', async () => {
    getInfraScopes.mockRejectedValue(new Error('scopes unavailable'));
    render(<InfraScopeEditor projectId="project-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('infra-scope-error')).toHaveTextContent('scopes unavailable'),
    );
  });

  it('clears every project-derived field when the next project fails to load', async () => {
    // Regression: only rows/projection/errors were reset, so a failed load left
    // the previous project's ceiling, degradation notice and service list on
    // screen, reading as statements about the project now selected.
    getInfraScopes
      .mockResolvedValueOnce(
        scopesResponse({
          scopes: [storedScope],
          monthlyCeilingUsd: 40,
          degradation: 'widened',
          collectableServices: ['ec2', 'rds', 'lambda'],
          maxScopes: 5,
          configured: true,
        }),
      )
      .mockRejectedValueOnce(new Error('scopes unavailable'));

    const { rerender } = render(<InfraScopeEditor projectId="project-a" />);
    await waitFor(() =>
      expect(screen.getByLabelText('Monthly cost ceiling (USD)')).toHaveValue('40'),
    );
    expect(screen.getByText(/running widened/)).toBeInTheDocument();

    rerender(<InfraScopeEditor projectId="project-b" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());

    // A ceiling is an editable field a save would write across, so it is the
    // most important of these not to inherit.
    expect(screen.getByLabelText('Monthly cost ceiling (USD)')).toHaveValue('');
    expect(screen.queryByText(/running widened/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument();
  });

  it('does not carry a project’s service list or scope cap into the next project', async () => {
    getInfraScopes
      .mockResolvedValueOnce(
        scopesResponse({ collectableServices: ['ec2', 'rds', 'lambda'], maxScopes: 1 }),
      )
      .mockRejectedValueOnce(new Error('scopes unavailable'));

    const { rerender } = render(<InfraScopeEditor projectId="project-a" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-editor')).toBeInTheDocument());
    // project-a caps the list at one scope, so Add is already exhausted there
    // after a single row.
    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));
    expect(screen.getByRole('button', { name: /Add scope/ })).toBeDisabled();

    rerender(<InfraScopeEditor projectId="project-b" />);
    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());

    // The rows were cleared either way, so the cap only shows itself once a row
    // exists again: under project-a's stale cap of 1, Add would lock after one.
    fireEvent.click(screen.getByRole('button', { name: /Add scope/ }));
    expect(screen.getByRole('button', { name: /Add scope/ })).not.toBeDisabled();
  });

  it('does not repaint the previous project’s scopes when the project changes', async () => {
    getInfraScopes
      .mockResolvedValueOnce(scopesResponse({ scopes: [storedScope], configured: true }))
      .mockRejectedValueOnce(new Error('scopes unavailable'));

    const { rerender } = render(<InfraScopeEditor projectId="project-a" />);
    await waitFor(() => expect(screen.getByLabelText('Profile')).toHaveValue('monitoring'));

    rerender(<InfraScopeEditor projectId="project-b" />);

    await waitFor(() => expect(screen.getByTestId('infra-scope-error')).toBeInTheDocument());
    expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument();
  });

  it('tells the page whether anything is actually scoped, on load and after save', async () => {
    const onScopesChange = vi.fn();
    getInfraScopes.mockResolvedValue(scopesResponse({ scopes: [storedScope], configured: true }));
    updateInfraScopes.mockResolvedValue(scopesResponse({ scopes: [], configured: false }));

    render(<InfraScopeEditor projectId="project-1" onScopesChange={onScopesChange} />);
    await waitFor(() => expect(onScopesChange).toHaveBeenCalledTimes(1));
    expect(onScopesChange.mock.calls[0]![0].scopes).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove scope' }));
    fireEvent.click(screen.getByRole('button', { name: /Save scope/ }));

    await waitFor(() => expect(onScopesChange).toHaveBeenCalledTimes(2));
    expect(onScopesChange.mock.calls[1]![0].scopes).toHaveLength(0);
  });
});
