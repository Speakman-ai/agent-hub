import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('../../utils/api', () => ({ api: {} }));

import { NOTIFICATION_SECTIONS } from '@shared/utils/notificationCategories';
import { catalogDefaults } from '../../utils/notificationPreferences';
import { NotificationPrefsContent, sectionPatch } from './PushNotificationsSection';

function render(props: Partial<React.ComponentProps<typeof NotificationPrefsContent>> = {}) {
  return renderToStaticMarkup(
    <NotificationPrefsContent
      loaded
      loading={false}
      error={null}
      prefs={catalogDefaults()}
      pushToken="ExponentPushToken[abc]"
      pushPermissionStatus="granted"
      expanded={{}}
      onToggleExpanded={() => undefined}
      onSave={() => undefined}
      onRetry={() => undefined}
      {...props}
    />,
  );
}

describe('PushNotificationsSection (per-user prefs)', () => {
  it('renders every catalog section and category with a channel summary', () => {
    const html = render();
    for (const s of NOTIFICATION_SECTIONS) {
      expect(html).toContain(`notification-section-${s.id}`);
      for (const c of s.categories) expect(html).toContain(c.label);
    }
    expect(html).toContain('apply to every device');
    // awaiting_feedback defaults on for every channel; session_completed in-app only.
    expect(html).toContain('In-app, Desktop, Push');
    expect(html).toContain('Granted');
  });

  it('shows per-channel switches only for an expanded category', () => {
    const collapsed = render();
    expect(collapsed).not.toContain('notification-toggle-dm-push');
    const html = render({ expanded: { dm: true } });
    expect(html).toContain('notification-toggle-dm-in_app');
    expect(html).toContain('notification-toggle-dm-desktop');
    expect(html).toContain('notification-toggle-dm-push');
    expect(html).not.toContain('notification-toggle-mention-push');
  });

  it('no longer renders the per-device event list', () => {
    const html = render();
    expect(html).not.toContain('Chat messages');
    expect(html).not.toContain('ExponentPushToken');
  });

  it('shows a retry affordance when the first load fails', () => {
    const html = render({ loaded: false, error: 'boom' });
    expect(html).toContain('boom');
    expect(html).toContain('Retry');
  });

  it('builds an all-channels patch for a section toggle', () => {
    expect(sectionPatch(['dm', 'mention'], false)).toEqual({
      dm: { in_app: false, desktop: false, push: false },
      mention: { in_app: false, desktop: false, push: false },
    });
  });
});
