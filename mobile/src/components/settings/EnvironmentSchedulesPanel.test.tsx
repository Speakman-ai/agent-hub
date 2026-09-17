import { describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer, TestRendererOptions } from 'react-test-renderer';

// Vitest inherits NODE_ENV=production in Agent Hub's test runner. Load the
// development React renderer explicitly so hooks flush interactively.
process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

// RN primitives + icons rendered as host components so react-test-renderer can
// serialize them and expose their props (onPress / onChangeText / visible).
function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: vi.fn() },
  Modal: nativeHost('Modal'),
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('lucide-react-native', () => ({
  CalendarClock: nativeHost('CalendarClock'),
  Check: nativeHost('Check'),
  ChevronDown: nativeHost('ChevronDown'),
  Plus: nativeHost('Plus'),
  Power: nativeHost('Power'),
  PowerOff: nativeHost('PowerOff'),
  Trash2: nativeHost('Trash2'),
}));
vi.mock('../../utils/api', () => ({ api: {} }));

const { EnvironmentSchedulesPanelContent, TimezoneSelect } =
  await import('./EnvironmentSchedulesPanel');
type DeploySchedule = import('../../utils/deploySchedules').DeploySchedule;

const rendererOptions: TestRendererOptions = { createNodeMock: () => ({}) };

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

function markup(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function renderContent(
  over: Partial<React.ComponentProps<typeof EnvironmentSchedulesPanelContent>> = {},
) {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(
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
      rendererOptions,
    );
  });
  return renderer;
}

function renderPicker(props: { value?: string; onChange?: (v: string) => void } = {}) {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(
      <TimezoneSelect value={props.value ?? ''} onChange={props.onChange ?? noop} />,
      rendererOptions,
    );
  });
  return renderer;
}

function press(renderer: ReactTestRenderer, query: Record<string, unknown>) {
  const node = renderer.root.findByProps(query);
  TestRenderer.act(() => node.props.onPress());
}

function typeSearch(renderer: ReactTestRenderer, value: string) {
  const input = renderer.root.findByProps({ accessibilityLabel: 'Search timezones' });
  TestRenderer.act(() => input.props.onChangeText(value));
}

function modalVisible(renderer: ReactTestRenderer): boolean {
  return renderer.root.findByProps({ testID: 'timezone-select-modal' }).props.visible;
}

// nativeHost renders each element as a composite + a host instance, so a prop
// query matches twice. Count the host instances (string type) for a stable tally.
function countOption(renderer: ReactTestRenderer, accessibilityLabel: string): number {
  return renderer.root
    .findAllByProps({ accessibilityLabel })
    .filter((n) => typeof n.type === 'string').length;
}

describe('EnvironmentSchedulesPanelContent (mobile)', () => {
  it('renders the empty state and add form fields', () => {
    const html = markup(renderContent());
    expect(html).toContain('No schedules yet');
    expect(html).toContain('env-schedules-prod');
    expect(html).toContain('Add schedule');
    expect(html).toContain('Ref');
    expect(html).toContain('Cron expression');
    expect(html).toContain('Timezone');
  });

  it('renders a schedule row with its ref and cron', () => {
    const html = markup(
      renderContent({
        schedules: [schedule({ id: 's7', ref: 'release/2.1', cron: '30 2 * * *' })],
      }),
    );
    expect(html).toContain('schedule-row-s7');
    expect(html).toContain('release/2.1');
    expect(html).toContain('30 2 * * *');
    expect(html).toContain('Disable schedule');
    expect(html).not.toContain('No schedules yet');
  });

  it('labels a disabled schedule with the Enable affordance', () => {
    const html = markup(renderContent({ schedules: [schedule({ enabled: false })] }));
    expect(html).toContain('Enable schedule');
  });

  it('surfaces a load error', () => {
    const html = markup(renderContent({ error: 'boom' }));
    expect(html).toContain('boom');
  });

  it('renders the timezone dropdown trigger instead of a free-text input', () => {
    const renderer = renderContent();
    expect(renderer.root.findByProps({ testID: 'timezone-select-trigger' })).toBeTruthy();
    // The old free-text timezone TextInput is gone: no editable text field is
    // labelled "Timezone" anymore (the search box is labelled "Search timezones").
    const timezoneTextInputs = renderer.root.findAll(
      (n) => (n.type as unknown) === 'TextInput' && n.props.accessibilityLabel === 'Timezone',
    );
    expect(timezoneTextInputs).toHaveLength(0);
  });
});

describe('TimezoneSelect (mobile)', () => {
  it('starts closed and shows the server-default label on the trigger', () => {
    const renderer = renderPicker({ value: '' });
    expect(modalVisible(renderer)).toBe(false);
    const trigger = renderer.root.findByProps({ testID: 'timezone-select-trigger' });
    expect(markup(renderer)).toContain('Server default timezone');
    expect(trigger.props.accessibilityLabel).toBe('Timezone');
  });

  it('shows the selected zone on the trigger', () => {
    const html = markup(renderPicker({ value: 'Europe/London' }));
    expect(html).toContain('Europe/London');
  });

  it('opens on trigger press and closes on overlay press', () => {
    const renderer = renderPicker();
    expect(modalVisible(renderer)).toBe(false);
    press(renderer, { testID: 'timezone-select-trigger' });
    expect(modalVisible(renderer)).toBe(true);
    press(renderer, { testID: 'timezone-select-overlay' });
    expect(modalVisible(renderer)).toBe(false);
  });

  it('filters the option list by the search query', () => {
    const renderer = renderPicker();
    press(renderer, { testID: 'timezone-select-trigger' });
    typeSearch(renderer, 'Honolulu');
    expect(countOption(renderer, 'Timezone Pacific/Honolulu')).toBe(1);
    expect(countOption(renderer, 'Timezone America/New_York')).toBe(0);
  });

  it('emits the chosen zone and closes on selection', () => {
    const onChange = vi.fn();
    const renderer = renderPicker({ onChange });
    press(renderer, { testID: 'timezone-select-trigger' });
    typeSearch(renderer, 'New_York');
    press(renderer, { accessibilityLabel: 'Timezone America/New_York' });
    expect(onChange).toHaveBeenCalledWith('America/New_York');
    expect(modalVisible(renderer)).toBe(false);
  });

  it('emits the empty server-default value when the default option is chosen', () => {
    const onChange = vi.fn();
    const renderer = renderPicker({ value: 'America/New_York', onChange });
    press(renderer, { testID: 'timezone-select-trigger' });
    press(renderer, { testID: 'timezone-option-default' });
    expect(onChange).toHaveBeenCalledWith('');
    expect(modalVisible(renderer)).toBe(false);
  });
});
