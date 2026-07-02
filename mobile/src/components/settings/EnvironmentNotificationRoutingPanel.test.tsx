import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives + icons rendered as host string tags so react-dom/server can
// serialize them (the mobile test env is `node`, no RN testing-library). Matches
// the EnvironmentSchedulesPanel static-render pattern.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles },
  Switch: 'Switch',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({
  Mail: 'Mail',
  Save: 'Save',
}));
vi.mock('../../utils/api', () => ({ api: {} }));

import { EnvironmentNotificationRoutingPanelContent } from './EnvironmentNotificationRoutingPanel';
import type { NotificationRouting } from '../../utils/deployNotificationRouting';

function routing(over: Partial<NotificationRouting> = {}): NotificationRouting {
  return {
    environmentName: 'prod',
    isProduction: true,
    ticketReleaseEnabled: true,
    releaseDigestEnabled: true,
    isDefault: true,
    updatedAt: null,
    ...over,
  };
}

const noop = () => undefined;

function renderContent(
  over: Partial<React.ComponentProps<typeof EnvironmentNotificationRoutingPanelContent>> = {},
) {
  return renderToStaticMarkup(
    <EnvironmentNotificationRoutingPanelContent
      environmentName="prod"
      routing={routing()}
      ticketReleaseEnabled
      releaseDigestEnabled
      loading={false}
      saving={false}
      error={null}
      dirty={false}
      onTicketReleaseChange={noop}
      onReleaseDigestChange={noop}
      onSave={noop}
      {...over}
    />,
  );
}

describe('EnvironmentNotificationRoutingPanelContent (mobile)', () => {
  it('renders the routing options and prod default chip', () => {
    const html = renderContent();
    expect(html).toContain('env-notification-routing-prod');
    expect(html).toContain('Reporter emails');
    expect(html).toContain('Release digest');
    expect(html).toContain('default (prod)');
    expect(html).toContain('Sends reporter emails + release digest on a successful deploy');
  });

  it('renders the non-prod off default and its summary', () => {
    const html = renderContent({
      environmentName: 'staging',
      routing: routing({
        environmentName: 'staging',
        isProduction: false,
        ticketReleaseEnabled: false,
        releaseDigestEnabled: false,
      }),
      ticketReleaseEnabled: false,
      releaseDigestEnabled: false,
    });
    expect(html).toContain('env-notification-routing-staging');
    expect(html).toContain('default (off)');
    expect(html).toContain('Sends nothing on a successful deploy');
  });

  it('labels a saved override as custom', () => {
    const html = renderContent({ routing: routing({ isDefault: false }) });
    expect(html).toContain('custom');
  });

  it('surfaces a load error', () => {
    const html = renderContent({ routing: null, error: 'boom' });
    expect(html).toContain('boom');
  });
});
