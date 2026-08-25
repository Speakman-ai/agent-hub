import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives + icons rendered as host string tags so react-dom/server can
// serialize them (the mobile test env is `node`, no RN testing-library). Matches
// the CalendarScreen / GoogleConnectionSection static-render pattern.
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
  Plus: 'Plus',
  Power: 'Power',
  PowerOff: 'PowerOff',
  Trash2: 'Trash2',
  Zap: 'Zap',
}));
vi.mock('../../utils/api', () => ({ api: {} }));

import { EnvironmentTriggersPanelContent } from './EnvironmentTriggersPanel';
import type { DeployTrigger } from '../../utils/deployTriggers';

function trigger(over: Partial<DeployTrigger> = {}): DeployTrigger {
  return {
    id: 't1',
    projectId: 'proj-1',
    environmentName: 'prod',
    event: 'push',
    branchPattern: 'main',
    enabled: true,
    meta: null,
    createdAt: '2026-07-02',
    updatedAt: '2026-07-02',
    ...over,
  };
}

const noop = () => undefined;

function renderContent(
  over: Partial<React.ComponentProps<typeof EnvironmentTriggersPanelContent>> = {},
) {
  return renderToStaticMarkup(
    <EnvironmentTriggersPanelContent
      environmentName="prod"
      triggers={[]}
      loading={false}
      error={null}
      actionKey={null}
      event="push"
      branchPattern=""
      adding={false}
      onEventChange={noop}
      onBranchPatternChange={noop}
      onAdd={noop}
      onToggle={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

describe('EnvironmentTriggersPanelContent (mobile)', () => {
  it('renders the empty state and add form with both event options', () => {
    const html = renderContent();
    expect(html).toContain('No triggers yet');
    expect(html).toContain('env-triggers-prod');
    // Both push/merge options and the Add control are offered.
    expect(html).toContain('Push');
    expect(html).toContain('Merge');
    expect(html).toContain('Add');
    expect(html).toContain('Branch pattern');
  });

  it('renders a trigger row with its event label and branch pattern', () => {
    const html = renderContent({
      triggers: [trigger({ id: 't7', event: 'merge', branchPattern: 'release/*' })],
    });
    expect(html).toContain('trigger-row-t7');
    expect(html).toContain('release/*');
    // Enabled trigger exposes the Disable affordance.
    expect(html).toContain('Disable trigger');
    expect(html).not.toContain('No triggers yet');
  });

  it('labels a disabled trigger with the Enable affordance', () => {
    const html = renderContent({ triggers: [trigger({ enabled: false })] });
    expect(html).toContain('Enable trigger');
  });

  it('surfaces a load error', () => {
    const html = renderContent({ error: 'boom' });
    expect(html).toContain('boom');
  });
});
