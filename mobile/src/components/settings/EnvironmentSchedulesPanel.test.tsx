import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives + icons rendered as host string tags so react-dom/server can
// serialize them (the mobile test env is `node`, no RN testing-library). Matches
// the EnvironmentTriggersPanel static-render pattern.
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
  CalendarClock: 'CalendarClock',
  Plus: 'Plus',
  Power: 'Power',
  PowerOff: 'PowerOff',
  Trash2: 'Trash2',
}));
vi.mock('../../utils/api', () => ({ api: {} }));

import { EnvironmentSchedulesPanelContent } from './EnvironmentSchedulesPanel';
import type { DeploySchedule } from '../../utils/deploySchedules';

function schedule(over: Partial<DeploySchedule> = {}): DeploySchedule {
  return {
    id: 's1',
    projectId: 'proj-1',
    environmentName: 'prod',
    ref: 'main',
    cron: '0 9 * * *',
    timezone: null,
    ownerUserId: 'u1',
    enabled: true,
    meta: null,
    createdAt: '2026-07-02',
    updatedAt: '2026-07-02',
    ...over,
  };
}

const noop = () => undefined;

function renderContent(
  over: Partial<React.ComponentProps<typeof EnvironmentSchedulesPanelContent>> = {},
) {
  return renderToStaticMarkup(
    <EnvironmentSchedulesPanelContent
      environmentName="prod"
      schedules={[]}
      loading={false}
      error={null}
      actionKey={null}
      refValue=""
      cron="0 9 * * *"
      timezone=""
      adding={false}
      onRefChange={noop}
      onCronChange={noop}
      onTimezoneChange={noop}
      onAdd={noop}
      onToggle={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

describe('EnvironmentSchedulesPanelContent (mobile)', () => {
  it('renders the empty state and add form fields', () => {
    const html = renderContent();
    expect(html).toContain('No schedules yet');
    expect(html).toContain('env-schedules-prod');
    expect(html).toContain('Add schedule');
    expect(html).toContain('Ref');
    expect(html).toContain('Cron expression');
    expect(html).toContain('Timezone');
  });

  it('renders a schedule row with its ref and cron', () => {
    const html = renderContent({
      schedules: [schedule({ id: 's7', ref: 'release/2.1', cron: '30 2 * * *' })],
    });
    expect(html).toContain('schedule-row-s7');
    expect(html).toContain('release/2.1');
    expect(html).toContain('30 2 * * *');
    // Enabled schedule exposes the Disable affordance.
    expect(html).toContain('Disable schedule');
    expect(html).not.toContain('No schedules yet');
  });

  it('labels a disabled schedule with the Enable affordance', () => {
    const html = renderContent({ schedules: [schedule({ enabled: false })] });
    expect(html).toContain('Enable schedule');
  });

  it('surfaces a load error', () => {
    const html = renderContent({ error: 'boom' });
    expect(html).toContain('boom');
  });
});
