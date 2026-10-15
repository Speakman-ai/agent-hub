import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: 'View',
}));
vi.mock('../../utils/api', () => ({
  api: {
    getMyBrowserProfiles: vi.fn(() => Promise.resolve({ profiles: [] })),
    clearBrowserProfileDomain: vi.fn(),
    deleteBrowserProfile: vi.fn(),
  },
}));

import BrowserProfilesSection from './BrowserProfilesSection';

describe('BrowserProfilesSection', () => {
  it('renders the header and the loading state before the first fetch resolves', () => {
    const html = renderToStaticMarkup(<BrowserProfilesSection />);
    expect(html).toContain('Browser Profiles');
    expect(html).toContain('Loading browser profiles');
  });
});
