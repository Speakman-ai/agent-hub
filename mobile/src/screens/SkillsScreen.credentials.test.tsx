import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Render RN primitives as plain string-tag hosts so renderToStaticMarkup can
// serialize the tree without a native runtime (same approach as
// SkillsScreen.pendingLessons.test.tsx).
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Linking: { openURL: () => {} },
  StyleSheet: {
    create: (styles: any) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: () => {} }) }));
vi.mock('react-native-markdown-display', () => ({ default: 'Markdown' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('../utils/auth', () => ({ hasRole: () => true, getUserRole: () => 'Admin' }));

import { SkillCredentialSection } from './SkillsScreen';

const SCHEMA = [
  {
    name: 'LINEAR_API_KEY',
    label: 'Linear API Key',
    description: 'Personal API key from Linear settings.',
    type: 'secret',
    required: true,
    docs_url: 'https://linear.app/settings/api',
  },
  {
    name: 'LINEAR_TEAM',
    label: 'Linear Team',
    type: 'text',
    required: false,
  },
];

describe('SkillsScreen — SkillCredentialSection mobile parity', () => {
  it('renders nothing when the schema is empty', () => {
    const html = renderToStaticMarkup(
      <SkillCredentialSection
        schema={[]}
        rows={[]}
        inputs={{}}
        onChangeInput={() => {}}
        onSave={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('renders a labelled input per spec, docs link, and a Save action', () => {
    const html = renderToStaticMarkup(
      <SkillCredentialSection
        schema={SCHEMA}
        rows={[]}
        inputs={{}}
        onChangeInput={() => {}}
        onSave={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain('Credentials');
    expect(html).toContain('Linear API Key');
    expect(html).toContain('LINEAR_API_KEY');
    expect(html).toContain('Personal API key from Linear settings.');
    expect(html).toContain('Documentation');
    expect(html).toContain('Save');
    // Optional vs required placeholders differ.
    expect(html).toContain('Required');
    expect(html).toContain('Optional');
  });

  it('shows the masked preview + Revoke only for a saved credential', () => {
    const html = renderToStaticMarkup(
      <SkillCredentialSection
        schema={SCHEMA}
        rows={[
          {
            id: 'cred-1',
            key_name: 'LINEAR_API_KEY',
            masked_preview: 'lin_…abcd',
            last_used_at: '2026-07-20T12:00:00Z',
          },
        ]}
        inputs={{}}
        onChangeInput={() => {}}
        onSave={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain('lin_…abcd');
    expect(html).toContain('Revoke');
    expect(html).toContain('Last used:');
  });

  it('surfaces the loading and error states', () => {
    const loadingHtml = renderToStaticMarkup(
      <SkillCredentialSection schema={SCHEMA} rows={[]} inputs={{}} loading />,
    );
    expect(loadingHtml).toContain('Loading saved values…');
    const errorHtml = renderToStaticMarkup(
      <SkillCredentialSection schema={SCHEMA} rows={[]} inputs={{}} error="boom" />,
    );
    expect(errorHtml).toContain('boom');
  });
});
