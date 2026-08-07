import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { api } from '../../utils/api.js';
import type {
  InfraHealthEventWire,
  InfraHealthEventsResponse,
  InfraHealthIngestResponse,
} from '../../utils/api.js';
import InfraHealthTimeline from './InfraHealthTimeline';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    getInfraHealthEvents: vi.fn(),
    getInfraHealthIngest: vi.fn(),
    createInfraHealthIngestToken: vi.fn(),
    revokeInfraHealthIngestToken: vi.fn(),
  },
}));

const EVENT_PATTERN = {
  source: ['aws.health'],
  'detail-type': ['AWS Health Event', 'AWS Health Abuse Event'],
};

function event(overrides: Partial<InfraHealthEventWire> = {}): InfraHealthEventWire {
  return {
    id: overrides.id ?? 'evt-1',
    projectId: 'project-1',
    eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
    communicationId: 'abc-1',
    region: 'us-east-1',
    deliveryRegion: 'us-east-1',
    detailType: 'AWS Health Event',
    service: 'EC2',
    eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    eventScopeCode: 'PUBLIC',
    statusCode: 'open',
    severity: 'critical',
    startTime: Date.now() - 60_000,
    endTime: null,
    lastUpdated: Date.now() - 60_000,
    description: 'Increased API error rates in us-east-1.',
    affectedEntities: [],
    affectedEntityCount: 0,
    backupEvent: false,
    page: 1,
    totalPages: 1,
    eventTime: Date.now() - 60_000,
    receivedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function body(events: InfraHealthEventWire[], ingestConfigured = true): InfraHealthEventsResponse {
  return { events, total: events.length, ingestConfigured };
}

function ingestBody(token: InfraHealthIngestResponse['token'] = null): InfraHealthIngestResponse {
  return {
    token,
    ingestPath: '/api/infra/health/ingest',
    eventPattern: EVENT_PATTERN,
  };
}

/**
 * Stand-in for the once-shown plaintext credential.
 *
 * Deliberately zero-entropy, hyphen-separated English: these assertions only
 * care that the component renders back exactly what the mint response returned,
 * so the value never needs to look like a real `ahhealth_` token — and a fixture
 * that does look like one is a standing invitation for a secret scanner, or a
 * human skimming the diff, to flag it.
 */
const FAKE_MINTED_TOKEN = 'ahhealth_example-not-a-real-token';

const liveToken = {
  projectId: 'project-1',
  tokenPrefix: 'ahhealth_abcd',
  createdAt: Date.now() - 3_600_000,
  rotatedAt: null,
  revokedAt: null,
  lastUsedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  // Fake timers so the 60s poll can be driven deterministically, matching the
  // sibling quota panel's suite.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([]));
  vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(liveToken));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InfraHealthTimeline', () => {
  it('renders an event with its service, type code, region and status', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([event()]));
    render(<InfraHealthTimeline projectId="project-1" />);

    expect(await screen.findByTestId('infra-health-list')).toBeTruthy();
    expect(screen.getByTestId('infra-health-service').textContent).toBe('EC2');
    expect(screen.getByTestId('infra-health-type-code').textContent).toBe(
      'AWS_EC2_OPERATIONAL_ISSUE',
    );
    expect(screen.getByTestId('infra-health-region').textContent).toBe('us-east-1');
    expect(screen.getByTestId('infra-health-status').textContent).toBe('open');
    expect(screen.getByTestId('infra-health-description').textContent).toContain(
      'Increased API error rates',
    );
  });

  it('orders the timeline newest first regardless of the order it was served in', async () => {
    const older = event({ id: 'old', service: 'RDS', startTime: 1_000 });
    const newer = event({ id: 'new', service: 'EC2', startTime: 9_000 });
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([older, newer]));
    render(<InfraHealthTimeline projectId="project-1" />);

    const rows = await screen.findAllByTestId('infra-health-service');
    expect(rows.map((el) => el.textContent)).toEqual(['EC2', 'RDS']);
  });

  it('falls back to receivedAt when AWS gave no start time', async () => {
    // A row with no timestamp at all reads as a rendering fault; the arrival
    // time is the weaker but honest answer.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(
      body([event({ startTime: null, receivedAt: Date.now() - 5_000 })]),
    );
    render(<InfraHealthTimeline projectId="project-1" />);
    expect((await screen.findByTestId('infra-health-time')).textContent).toMatch(/ago|just now/);
  });

  it('carries severity on the row and labels it in words', async () => {
    // Colour alone cannot carry severity, so the dot is paired with a label and
    // the row itself is stamped for anything reading the DOM.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(
      body([
        event({ id: 'a', severity: 'critical' }),
        event({ id: 'b', severity: 'warning', startTime: 2 }),
        event({ id: 'c', severity: 'info', startTime: 1 }),
      ]),
    );
    render(<InfraHealthTimeline projectId="project-1" />);

    const rows = await screen.findAllByTestId('infra-health-event');
    expect(rows.map((el) => el.getAttribute('data-severity'))).toEqual([
      'critical',
      'warning',
      'info',
    ]);
    expect(screen.getAllByTestId('infra-health-severity').map((el) => el.textContent)).toEqual([
      'Critical',
      'Warning',
      'Info',
    ]);
  });

  it('counts affected entities only when there are any', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(
      body([
        event({
          affectedEntityCount: 3,
          affectedEntities: [{ entityValue: 'i-1', status: 'IMPAIRED', lastUpdatedMs: 1 }],
        }),
      ]),
    );
    const { rerender } = render(<InfraHealthTimeline projectId="project-1" />);
    expect((await screen.findByTestId('infra-health-entities')).textContent).toBe(
      '3 affected resources',
    );

    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(
      body([event({ affectedEntityCount: 0 })]),
    );
    rerender(<InfraHealthTimeline projectId="project-2" />);
    await waitFor(() => expect(screen.queryByTestId('infra-health-entities')).toBeNull());
  });

  it('marks a backup-Region delivery and explains why the duplicate is expected', async () => {
    // Without this an operator sees the same incident twice and reasonably
    // files a bug against the ingest path.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(
      body([event({ backupEvent: true, deliveryRegion: 'us-west-2' })]),
    );
    render(<InfraHealthTimeline projectId="project-1" />);

    const marker = await screen.findByTestId('infra-health-backup');
    expect(marker.textContent).toContain('backup Region');
    expect(marker.getAttribute('title')).toMatch(/backup Region/i);
    expect(marker.getAttribute('title')).toMatch(/twice/i);
  });

  it('omits the backup marker on a normally-delivered event', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([event({ backupEvent: false })]));
    render(<InfraHealthTimeline projectId="project-1" />);
    await screen.findByTestId('infra-health-list');
    expect(screen.queryByTestId('infra-health-backup')).toBeNull();
  });

  it('clamps a long description behind an expand affordance', async () => {
    const long = 'x'.repeat(400);
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([event({ description: long })]));
    render(<InfraHealthTimeline projectId="project-1" />);

    const description = await screen.findByTestId('infra-health-description');
    expect(description.className).toContain('line-clamp-2');

    fireEvent.click(screen.getByTestId('infra-health-expand'));
    await waitFor(() =>
      expect(screen.getByTestId('infra-health-description').className).not.toContain(
        'line-clamp-2',
      ),
    );
    expect(screen.getByTestId('infra-health-expand').textContent).toBe('Show less');
  });

  it('offers no expand affordance for a short description', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([event({ description: 'Short.' })]));
    render(<InfraHealthTimeline projectId="project-1" />);
    await screen.findByTestId('infra-health-description');
    expect(screen.queryByTestId('infra-health-expand')).toBeNull();
  });

  it('surfaces a read failure rather than an empty timeline', async () => {
    vi.mocked(api.getInfraHealthEvents).mockRejectedValue(new Error('boom'));
    render(<InfraHealthTimeline projectId="project-1" />);
    expect((await screen.findByTestId('infra-health-error')).textContent).toBe('boom');
    expect(screen.queryByTestId('infra-health-list')).toBeNull();
  });

  it('survives a synchronous throw from the API layer', async () => {
    // This panel sits above the spend panels on the Overview tab; a synchronous
    // throw escapes the promise chain and would unmount the whole tab.
    vi.mocked(api.getInfraHealthEvents).mockImplementation(() => {
      throw new Error('api unavailable');
    });
    render(<InfraHealthTimeline projectId="project-1" />);
    expect((await screen.findByTestId('infra-health-error')).textContent).toBe('api unavailable');
  });

  it('survives a synchronous throw from the lazy ingest read', async () => {
    // The ingest read runs inside an effect, so an unguarded synchronous throw
    // does not merely fail the fetch — it unwinds to the nearest error boundary
    // and takes the Overview tab with it.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], false));
    vi.mocked(api.getInfraHealthIngest).mockImplementation(() => {
      throw new Error('ingest api unavailable');
    });

    render(<InfraHealthTimeline projectId="project-1" />);

    expect((await screen.findByTestId('infra-health-setup-error')).textContent).toBe(
      'ingest api unavailable',
    );
    // The rest of the panel is still mounted rather than replaced by a boundary.
    expect(screen.getByTestId('infra-health-not-configured')).toBeTruthy();
  });

  it('survives a synchronous throw from mint and releases the busy flag', async () => {
    // Worse than the read case: `setBusy(true)` has already run, so a throw that
    // skips the promise chain also skips `.finally()` and strands the button
    // disabled with no way back short of a reload.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], false));
    vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(null));
    vi.mocked(api.createInfraHealthIngestToken).mockImplementation(() => {
      throw new Error('mint api unavailable');
    });

    render(<InfraHealthTimeline projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-health-mint'));

    expect((await screen.findByTestId('infra-health-setup-error')).textContent).toBe(
      'mint api unavailable',
    );
    expect((screen.getByTestId('infra-health-mint') as HTMLButtonElement).disabled).toBe(false);
  });

  it('survives a synchronous throw from revoke and releases the busy flag', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], true));
    vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(liveToken));
    vi.mocked(api.revokeInfraHealthIngestToken).mockImplementation(() => {
      throw new Error('revoke api unavailable');
    });

    render(<InfraHealthTimeline projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-health-setup-toggle'));
    fireEvent.click(await screen.findByTestId('infra-health-revoke'));

    expect((await screen.findByTestId('infra-health-setup-error')).textContent).toBe(
      'revoke api unavailable',
    );
    expect((screen.getByTestId('infra-health-revoke') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('InfraHealthTimeline empty states', () => {
  it('says ingest was never configured when no token exists', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], false));
    vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(null));
    render(<InfraHealthTimeline projectId="project-1" />);

    const empty = await screen.findByTestId('infra-health-not-configured');
    expect(empty.textContent).toContain('AWS Health ingest not configured');
    // And crucially NOT the quiet-but-working message.
    expect(screen.queryByTestId('infra-health-empty')).toBeNull();
  });

  it('says nothing has arrived yet when ingest IS configured', async () => {
    // The whole point of the distinction: identical-looking blank slates would
    // hide whether the operator has a rule to go build or a calm account.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], true));
    render(<InfraHealthTimeline projectId="project-1" />);

    const empty = await screen.findByTestId('infra-health-empty');
    expect(empty.textContent).toContain('No AWS Health events received yet');
    expect(screen.queryByTestId('infra-health-not-configured')).toBeNull();
  });

  it('opens the setup section by itself only when ingest is unconfigured', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], false));
    vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(null));
    const { unmount } = render(<InfraHealthTimeline projectId="project-1" />);
    expect(await screen.findByTestId('infra-health-setup')).toBeTruthy();
    unmount();

    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([event()], true));
    render(<InfraHealthTimeline projectId="project-1" />);
    await screen.findByTestId('infra-health-list');
    expect(screen.queryByTestId('infra-health-setup')).toBeNull();
  });
});

describe('InfraHealthTimeline ingest setup', () => {
  async function openSetup() {
    render(<InfraHealthTimeline projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-health-setup-toggle'));
    return screen.findByTestId('infra-health-setup');
  }

  it('publishes the ingest URL and the exact EventBridge pattern', async () => {
    await openSetup();

    await waitFor(() =>
      expect(screen.getByTestId('infra-health-ingest-url').textContent).toContain(
        '/api/infra/health/ingest',
      ),
    );
    const pattern = screen.getByTestId('infra-health-event-pattern');
    expect(JSON.parse(pattern.textContent || '{}')).toEqual(EVENT_PATTERN);
  });

  it('warns that a wildcard source never matches and that the rule is the operator’s to make', async () => {
    // The single most likely setup failure is `aws.health*`, which matches
    // nothing forever and silently.
    await openSetup();
    const note = await screen.findByTestId('infra-health-setup-note');
    expect(note.textContent).toContain('aws.health*');
    expect(note.textContent).toMatch(/never matches/i);
    expect(note.textContent).toMatch(/cannot create this rule for you/i);
  });

  it('shows the minted token once, with an explicit only-once warning', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], false));
    vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(null));
    vi.mocked(api.createInfraHealthIngestToken).mockResolvedValue({
      token: FAKE_MINTED_TOKEN,
      info: liveToken,
      ingestPath: '/api/infra/health/ingest',
      eventPattern: EVENT_PATTERN,
    });

    render(<InfraHealthTimeline projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-health-mint'));

    expect((await screen.findByTestId('infra-health-token-plaintext')).textContent).toBe(
      FAKE_MINTED_TOKEN,
    );
    expect(screen.getByTestId('infra-health-token-warning').textContent).toMatch(/only once/i);
    expect(screen.getByTestId('infra-health-token-warning').textContent).toMatch(
      /never be read back/i,
    );
  });

  it('never re-renders the plaintext after a project switch', async () => {
    // The credential belongs to one project and cannot be re-fetched to correct
    // itself, so carrying it across a switch would be showing project A's secret
    // under project B's header.
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([], false));
    vi.mocked(api.getInfraHealthIngest).mockResolvedValue(ingestBody(null));
    vi.mocked(api.createInfraHealthIngestToken).mockResolvedValue({
      token: FAKE_MINTED_TOKEN,
      info: liveToken,
      ingestPath: '/api/infra/health/ingest',
      eventPattern: EVENT_PATTERN,
    });

    const { rerender } = render(<InfraHealthTimeline projectId="project-1" />);
    fireEvent.click(await screen.findByTestId('infra-health-mint'));
    await screen.findByTestId('infra-health-token-plaintext');

    rerender(<InfraHealthTimeline projectId="project-2" />);
    await waitFor(() => expect(screen.queryByTestId('infra-health-token-plaintext')).toBeNull());
  });

  it('offers rotate and revoke once a live token exists, and drops revoke after', async () => {
    vi.mocked(api.revokeInfraHealthIngestToken).mockResolvedValue({
      revoked: true,
      token: { ...liveToken, revokedAt: Date.now() },
    });
    await openSetup();

    expect((await screen.findByTestId('infra-health-mint')).textContent).toContain('Rotate');
    fireEvent.click(screen.getByTestId('infra-health-revoke'));

    await waitFor(() => expect(screen.queryByTestId('infra-health-revoke')).toBeNull());
    expect(screen.getByTestId('infra-health-mint').textContent).toContain('Create');
  });

  it('reports a mint failure instead of pretending a token exists', async () => {
    vi.mocked(api.createInfraHealthIngestToken).mockRejectedValue(new Error('forbidden'));
    await openSetup();

    fireEvent.click(await screen.findByTestId('infra-health-mint'));
    expect((await screen.findByTestId('infra-health-setup-error')).textContent).toBe('forbidden');
    expect(screen.queryByTestId('infra-health-token-plaintext')).toBeNull();
  });
});

describe('InfraHealthTimeline live updates', () => {
  it('refetches when a broadcast for this project arrives', async () => {
    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([]));
    render(<InfraHealthTimeline projectId="project-1" />);
    await screen.findByTestId('infra-health-empty');
    expect(vi.mocked(api.getInfraHealthEvents)).toHaveBeenCalledTimes(1);

    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(body([event({ service: 'RDS' })]));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('infra_health_event', {
          detail: { projectId: 'project-1', healthEventId: 'evt-1', severity: 'critical' },
        }),
      );
    });

    expect((await screen.findByTestId('infra-health-service')).textContent).toBe('RDS');
  });

  it('does not let a slow earlier read overwrite a newer one', async () => {
    // Regression: the in-flight guard used to key on the project epoch only, so
    // two reads for the SAME project each considered the other current and
    // whichever finished last won. A slow mount fetch landing after a fast
    // broadcast-triggered refetch would repaint the list without the very
    // outage that triggered it, and it would stay missing for a full poll
    // interval — exactly when someone is watching.
    let resolveFirst!: (value: InfraHealthEventsResponse) => void;
    const slowFirst = new Promise<InfraHealthEventsResponse>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(api.getInfraHealthEvents)
      .mockReturnValueOnce(slowFirst)
      .mockResolvedValueOnce(body([event({ id: 'outage', service: 'RDS' })]));

    render(<InfraHealthTimeline projectId="project-1" />);

    // The broadcast fires while the mount read is still in flight.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('infra_health_event', { detail: { projectId: 'project-1' } }),
      );
    });
    expect((await screen.findByTestId('infra-health-service')).textContent).toBe('RDS');

    // Now the stale mount read finally lands, carrying an empty list.
    await act(async () => {
      resolveFirst(body([]));
      await slowFirst;
    });

    expect(screen.getByTestId('infra-health-service').textContent).toBe('RDS');
    expect(screen.queryByTestId('infra-health-empty')).toBeNull();
  });

  it('ignores a broadcast for a different project', async () => {
    // The server fans this out to every connected client, so an unfiltered
    // listener would refetch on every other project's outage.
    render(<InfraHealthTimeline projectId="project-1" />);
    await screen.findByTestId('infra-health-empty');
    vi.mocked(api.getInfraHealthEvents).mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('infra_health_event', { detail: { projectId: 'project-2' } }),
      );
    });

    expect(vi.mocked(api.getInfraHealthEvents)).not.toHaveBeenCalled();
  });

  it('keeps polling as a floor under the socket', async () => {
    // A socket that reconnects mid-incident drops whatever landed while it was
    // down; the poll is what stops that becoming a silently missed outage.
    render(<InfraHealthTimeline projectId="project-1" />);
    await screen.findByTestId('infra-health-empty');
    expect(vi.mocked(api.getInfraHealthEvents)).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.mocked(api.getInfraHealthEvents)).toHaveBeenCalledTimes(2);
  });
});

describe('InfraHealthTimeline project switching', () => {
  it('does not paint a stale project’s events over the current one', async () => {
    let settleFirst: (value: InfraHealthEventsResponse) => void = () => {};
    vi.mocked(api.getInfraHealthEvents).mockReturnValueOnce(
      new Promise<InfraHealthEventsResponse>((resolve) => {
        settleFirst = resolve;
      }),
    );

    const { rerender } = render(<InfraHealthTimeline projectId="project-1" />);

    vi.mocked(api.getInfraHealthEvents).mockResolvedValue(
      body([event({ id: 'two', service: 'Lambda' })]),
    );
    rerender(<InfraHealthTimeline projectId="project-2" />);
    await screen.findByText('Lambda');

    settleFirst(body([event({ id: 'one', service: 'DynamoDB' })]));
    await waitFor(() => expect(screen.queryByText('DynamoDB')).toBeNull());
    expect(screen.getByText('Lambda')).toBeTruthy();
  });
});
