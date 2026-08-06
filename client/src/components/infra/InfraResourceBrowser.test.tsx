/**
 * The inventory browser: filter -> query translation, the staleness default
 * that stops the list opening on every instance an account ever ran, and the
 * project-switch guards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InfraResourceBrowser, {
  EMPTY_FILTERS,
  NO_ENVIRONMENT,
  formatAge,
  hasActiveFilters,
  isStaleResource,
  toResourceQuery,
} from './InfraResourceBrowser';
import { api } from '../../utils/api';

(vi as any).mock('../../utils/api.js', () => ({
  api: { listInfraResources: vi.fn() },
}));

const listInfraResources = vi.mocked(api.listInfraResources);

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function resource(over: Record<string, any> = {}) {
  return {
    resourceKey: 'proj-a|111122223333|us-east-1|ec2|i-0abc',
    accountId: '111122223333',
    region: 'us-east-1',
    service: 'ec2',
    resourceId: 'i-0abc',
    name: 'web-1',
    environment: 'prod',
    state: 'running',
    tags: { Name: 'web-1' },
    firstSeen: NOW - 48 * HOUR,
    lastSeen: NOW,
    ...over,
  };
}

function listResponse(over: Record<string, any> = {}) {
  return {
    resources: [resource()],
    nextCursor: null,
    facets: {
      services: ['ec2', 'rds'],
      regions: ['us-east-1'],
      accounts: ['111122223333'],
      environments: ['prod'],
      states: ['running'],
      tagKeys: ['Team'],
      total: 1,
    },
    staleAfterMs: 24 * HOUR,
    ...over,
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  listInfraResources.mockResolvedValue(listResponse());
});

describe('toResourceQuery', () => {
  it('sends nothing for an untouched filter set', () => {
    const query = toResourceQuery(EMPTY_FILTERS);
    expect(query.service).toBe('');
    expect(query.search).toBe('');
    // Absent, not zero: absent means "use the collector's staleness default",
    // which is the opposite of what the include-stale toggle asks for.
    expect(query.seenSince).toBeUndefined();
  });

  it('asks for everything ever described only when the toggle is on', () => {
    expect(toResourceQuery({ ...EMPTY_FILTERS, includeStale: true }).seenSince).toBe(0);
  });

  it('drops a tag value with no key behind it', () => {
    // The server ignores it, so sending it would make the request claim a
    // filter that is not being applied.
    expect(toResourceQuery({ ...EMPTY_FILTERS, tagValue: 'prod' }).tagValue).toBe('');
    expect(toResourceQuery({ ...EMPTY_FILTERS, tagKey: 'Team', tagValue: 'prod' }).tagValue).toBe(
      'prod',
    );
  });

  it('trims a search term', () => {
    expect(toResourceQuery({ ...EMPTY_FILTERS, search: '  i-0abc ' }).search).toBe('i-0abc');
  });
});

describe('hasActiveFilters', () => {
  it('ignores the staleness toggle, which is a view not a filter', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, includeStale: true })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, service: 'ec2' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: '  ' })).toBe(false);
  });
});

describe('formatAge', () => {
  it('reads down from minutes to days', () => {
    expect(formatAge(NOW - 30 * 1000, NOW)).toBe('just now');
    expect(formatAge(NOW - 5 * 60 * 1000, NOW)).toBe('5m ago');
    expect(formatAge(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(formatAge(NOW - 50 * HOUR, NOW)).toBe('2d ago');
  });

  it('reads clock skew as "just now" rather than a negative age', () => {
    expect(formatAge(NOW + HOUR, NOW)).toBe('just now');
  });
});

describe('isStaleResource', () => {
  it('marks a row the collector has stopped polling', () => {
    expect(isStaleResource({ lastSeen: NOW - HOUR }, 24 * HOUR, NOW)).toBe(false);
    expect(isStaleResource({ lastSeen: NOW - 48 * HOUR }, 24 * HOUR, NOW)).toBe(true);
  });
});

describe('InfraResourceBrowser', () => {
  it('lists rows and populates the filter controls from the facets', async () => {
    render(<InfraResourceBrowser projectId="p1" />);

    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1));
    expect(screen.getByText('i-0abc')).toBeTruthy();
    const services = screen.getByLabelText('Service') as HTMLSelectElement;
    expect([...services.options].map((o) => o.value)).toEqual(['', 'ec2', 'rds']);
  });

  it('sends the filter as a query when a control changes', async () => {
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(listInfraResources).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'rds' } });

    await waitFor(() =>
      expect(listInfraResources).toHaveBeenLastCalledWith(
        'p1',
        expect.objectContaining({ service: 'rds' }),
      ),
    );
  });

  it('offers an unlabelled-environment option the facets cannot provide', async () => {
    // An equality filter cannot express "no label", and unlabelled resources
    // are exactly what you look for when hunting what is not yet joined to a
    // deployment.
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(listInfraResources).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: NO_ENVIRONMENT } });

    await waitFor(() =>
      expect(listInfraResources).toHaveBeenLastCalledWith(
        'p1',
        expect.objectContaining({ environment: NO_ENVIRONMENT }),
      ),
    );
  });

  it('flags a row the collector has stopped polling rather than hiding it', async () => {
    listInfraResources.mockResolvedValue(
      listResponse({ resources: [resource({ lastSeen: NOW - 72 * HOUR })] }),
    );
    render(<InfraResourceBrowser projectId="p1" />);

    await waitFor(() => expect(screen.getByText('(not polled)')).toBeTruthy());
  });

  it('distinguishes an empty project from an over-filtered one', async () => {
    listInfraResources.mockResolvedValue(listResponse({ resources: [] }));
    render(<InfraResourceBrowser projectId="p1" />);

    await waitFor(() => expect(screen.getByTestId('infra-resources-empty')).toBeTruthy());
    expect(screen.getByTestId('infra-resources-empty').textContent).toContain(
      'No resources discovered yet',
    );

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'rds' } });
    await waitFor(() =>
      expect(screen.getByTestId('infra-resources-empty').textContent).toContain(
        'No resources match these filters',
      ),
    );
  });

  it('reports a failed load and does not leave the previous list up', async () => {
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1));

    listInfraResources.mockRejectedValue(new Error('nope'));
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'rds' } });

    await waitFor(() => expect(screen.getByTestId('infra-resources-error')).toBeTruthy());
    expect(screen.queryAllByTestId('infra-resource-row')).toHaveLength(0);
  });

  it('does not present a pending filter change as the previous failure', async () => {
    // Regression: the filter/project effect cleared the rows but not `error`,
    // so a new request rendered an empty table under the *old* failure and a
    // load that had not finished read as already broken.
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1));

    listInfraResources.mockRejectedValueOnce(new Error('gateway down'));
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByTestId('infra-resources-error')).toBeTruthy());

    // A filter change asks a different question; the previous answer's failure
    // must not survive into it. Held in flight so the assertion lands on the
    // pending state rather than on the response that clears it anyway.
    listInfraResources.mockReturnValue(new Promise(() => {}) as any);
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'rds' } });

    await waitFor(() => expect(screen.queryByTestId('infra-resources-error')).toBeNull());
    expect(screen.queryByTestId('infra-resources-stale')).toBeNull();
  });

  it('does not present a pending project switch as the previous failure', async () => {
    const { rerender } = render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1));

    listInfraResources.mockRejectedValueOnce(new Error('gateway down'));
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByTestId('infra-resources-error')).toBeTruthy());

    listInfraResources.mockReturnValue(new Promise(() => {}) as any);
    rerender(<InfraResourceBrowser projectId="p2" />);

    await waitFor(() => expect(screen.queryByTestId('infra-resources-error')).toBeNull());
  });

  it('marks the list stale when a manual refresh fails', async () => {
    // Regression: a failed refresh left the previous rows rendered normally
    // beside the error banner, so an old inventory read as current data.
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('infra-resources-table')).toBeTruthy());

    listInfraResources.mockRejectedValue(new Error('gateway down'));
    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => expect(screen.getByTestId('infra-resources-stale')).toBeTruthy());
    // The rows stay — they are the best answer anyone has — but they are no
    // longer presented as current.
    expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1);
    expect(screen.getByTestId('infra-resources-error').textContent).toContain('not current');
    expect(screen.queryByTestId('infra-resources-table')).toBeNull();
  });

  it('marks the list stale when a background poll fails', async () => {
    vi.useFakeTimers();
    try {
      render(<InfraResourceBrowser projectId="p1" />);
      await vi.waitFor(() => expect(screen.getByTestId('infra-resources-table')).toBeTruthy());

      listInfraResources.mockRejectedValue(new Error('gateway down'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByTestId('infra-resources-stale')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not blank a healthy list while a refresh is in flight', async () => {
    // Clearing the rows at the start of each refresh would flash the table
    // empty once a minute on a working Hub, which trains the operator to
    // ignore an empty table — the one state that has to stay meaningful.
    //
    // Asserted against a request that never settles, because that is the only
    // way to observe the in-flight window: a refresh whose promise resolves
    // repaints the rows before any assertion can run, so a `clear-then-fetch`
    // implementation would pass a test that awaited the response.
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1));

    listInfraResources.mockReturnValue(new Promise(() => {}) as any);
    fireEvent.click(screen.getByText('Refresh'));

    expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1);
    expect(screen.queryByTestId('infra-resources-stale')).toBeNull();
  });

  it('keeps the stale marking across a second failing refresh', async () => {
    // The marking is driven by `error`, which is cleared on success rather than
    // at request start: clearing up front would drop it for the duration of
    // every retry, so a Hub failing every poll would look fine most of the time.
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('infra-resources-table')).toBeTruthy());

    listInfraResources.mockRejectedValue(new Error('still down'));
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByTestId('infra-resources-stale')).toBeTruthy());

    fireEvent.click(screen.getByText('Refresh'));
    expect(screen.getByTestId('infra-resources-stale')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('infra-resources-stale')).toBeTruthy());
  });

  it('clears the stale marking once a refresh succeeds again', async () => {
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('infra-resources-table')).toBeTruthy());

    listInfraResources.mockRejectedValueOnce(new Error('blip'));
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByTestId('infra-resources-stale')).toBeTruthy());

    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByTestId('infra-resources-table')).toBeTruthy());
    expect(screen.queryByTestId('infra-resources-error')).toBeNull();
  });

  it('withholds paging while the list is stale', async () => {
    // A next page fetched now would be appended to rows from an older
    // snapshot, and a half-fresh list is harder to reason about than either.
    listInfraResources.mockResolvedValue(listResponse({ nextCursor: 'cursor-1' }));
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getByText('Load more')).toBeTruthy());

    listInfraResources.mockRejectedValue(new Error('gateway down'));
    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => expect(screen.getByTestId('infra-resources-stale')).toBeTruthy());
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('resets filters on a project switch', async () => {
    // Carrying one project's service selection into another silently shows an
    // empty list for a project that does have resources.
    const { rerender } = render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(listInfraResources).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'rds' } });
    await waitFor(() =>
      expect(listInfraResources).toHaveBeenLastCalledWith(
        'p1',
        expect.objectContaining({ service: 'rds' }),
      ),
    );

    rerender(<InfraResourceBrowser projectId="p2" />);

    await waitFor(() => {
      const [projectId, params] = listInfraResources.mock.calls.at(-1) as [
        string,
        Record<string, unknown>,
      ];
      expect(projectId).toBe('p2');
      expect(params.service).toBe('');
    });
  });

  it('hands the chosen resource to its caller', async () => {
    const onSelectResource = vi.fn();
    render(<InfraResourceBrowser projectId="p1" onSelectResource={onSelectResource} />);

    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId('infra-resource-row')[0]);

    expect(onSelectResource).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'i-0abc' }),
    );
  });

  it('appends a page rather than replacing the list', async () => {
    listInfraResources.mockResolvedValueOnce(listResponse({ nextCursor: 'cursor-1' }));
    render(<InfraResourceBrowser projectId="p1" />);
    await waitFor(() => expect(screen.getByText('Load more')).toBeTruthy());

    listInfraResources.mockResolvedValueOnce(
      listResponse({ resources: [resource({ resourceKey: 'k2', resourceId: 'i-second' })] }),
    );
    fireEvent.click(screen.getByText('Load more'));

    await waitFor(() => expect(screen.getAllByTestId('infra-resource-row')).toHaveLength(2));
    expect(listInfraResources).toHaveBeenLastCalledWith(
      'p1',
      expect.objectContaining({ cursor: 'cursor-1' }),
    );
  });
});
