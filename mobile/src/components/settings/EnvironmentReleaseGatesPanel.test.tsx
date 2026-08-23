import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// RN primitives + icons rendered as host string tags so react-dom/server can
// serialize them (the mobile test env is `node`). Matches the
// EnvironmentSchedulesPanel static-render pattern.
import { vi } from 'vitest';
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({
  CheckSquare: 'CheckSquare',
  Plus: 'Plus',
  Power: 'Power',
  PowerOff: 'PowerOff',
  Rocket: 'Rocket',
  Square: 'Square',
  Trash2: 'Trash2',
}));
vi.mock('../../utils/api', () => ({ api: {} }));

import {
  EnvironmentReleaseGatesPanelContent,
  type ReleaseGatePickOption,
} from './EnvironmentReleaseGatesPanel';
import type { DeployReleaseGate } from '../../utils/deployReleaseGates';

function gate(over: Partial<DeployReleaseGate> = {}): DeployReleaseGate {
  return {
    id: 'g1',
    projectId: 'proj-1',
    environmentName: 'prod',
    ref: 'main',
    sessionIds: ['sess-a'],
    epicIds: [],
    ownerUserId: 'u1',
    status: 'armed',
    enabled: true,
    firedDeploymentId: null,
    lastError: null,
    resolvedAt: null,
    progress: {
      sessions: [{ id: 'sess-a', state: 'pending' }],
      epics: [],
      sessionsComplete: 0,
      sessionsTotal: 1,
      epicsComplete: 0,
      epicsTotal: 0,
      blocked: false,
      satisfied: false,
    },
    meta: null,
    createdAt: '2026-08-20',
    updatedAt: '2026-08-20',
    ...over,
  };
}

const noop = () => undefined;

function renderContent(
  over: Partial<React.ComponentProps<typeof EnvironmentReleaseGatesPanelContent>> = {},
) {
  const sessionOptions: ReleaseGatePickOption[] = [{ id: 'sess-a', label: 'Fix auth' }];
  const epicOptions: ReleaseGatePickOption[] = [{ id: 'epic-1', label: 'Billing' }];
  return renderToStaticMarkup(
    <EnvironmentReleaseGatesPanelContent
      environmentName="prod"
      gates={[]}
      sessionOptions={sessionOptions}
      epicOptions={epicOptions}
      loading={false}
      error={null}
      actionKey={null}
      refValue=""
      selectedSessions={{}}
      selectedEpics={{}}
      adding={false}
      onRefChange={noop}
      onToggleSessionOption={noop}
      onToggleEpicOption={noop}
      onAdd={noop}
      onToggle={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

describe('EnvironmentReleaseGatesPanelContent', () => {
  it('renders an empty state and pickable options', () => {
    const html = renderContent();
    expect(html).toContain('No release gates yet');
    expect(html).toContain('Fix auth');
    expect(html).toContain('Billing');
  });

  it('renders a gate row with progress and status', () => {
    const html = renderContent({ gates: [gate()] });
    expect(html).toContain('main');
    expect(html).toContain('waiting');
    expect(html).toContain('0/1 sessions');
    expect(html).toContain('Creating it is the approval');
  });

  it('renders the blocked status when a selection is missing', () => {
    const html = renderContent({
      gates: [
        gate({
          progress: {
            sessions: [{ id: 'sess-a', state: 'missing' }],
            epics: [],
            sessionsComplete: 0,
            sessionsTotal: 1,
            epicsComplete: 0,
            epicsTotal: 0,
            blocked: true,
            satisfied: false,
          },
        }),
      ],
    });
    expect(html).toContain('blocked');
  });

  it('renders a failed gate with its error', () => {
    const html = renderContent({
      gates: [gate({ status: 'failed', lastError: 'runner exploded' })],
    });
    expect(html).toContain('failed');
    expect(html).toContain('runner exploded');
  });
});
