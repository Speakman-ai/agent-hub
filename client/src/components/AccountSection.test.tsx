import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock auth + connection helpers BEFORE importing the component so the
// component picks up our mocked role + fetch base instead of touching
// localStorage / the network.
(vi as any).mock('../utils/auth.js', () => ({
  hasRole: vi.fn(),
  getUserRole: vi.fn(),
  logout: vi.fn(async () => {}),
}));

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
}));

import AccountSection, {
  PluginApiKeysSection,
  TranscriptionProviderRow,
  roleOptionsFor,
} from './AccountSection';
import { hasRole, getUserRole, logout } from '../utils/auth';

beforeEach(() => {
  (hasRole as any).mockReset();
  (getUserRole as any).mockReset();
  (logout as any).mockReset();
  (logout as any).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchSequence(responses: any) {
  const fetchMock = vi.fn();
  responses.forEach((r: any) => (fetchMock as any).mockResolvedValueOnce(r));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: any, status: any = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// URL+method-aware fetch mock. Order-independent so the several on-mount loads
// inside PluginApiKeysSection (transcription provider, gemini auth, openai key)
// can fire in any sequence without the test caring.
function mockFetchByUrl(handlers: any) {
  const fetchMock = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const handler = handlers.find((h: any) => h.match(u, method));
    if (!handler) throw new Error(`unhandled fetch: ${method} ${u}`);
    return typeof handler.response === 'function' ? handler.response(u, init) : handler.response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('roleOptionsFor', () => {
  it('returns [Owner, Admin, User] for Owner caller', () => {
    expect(roleOptionsFor('Owner')).toEqual(['Owner', 'Admin', 'User']);
  });

  it('returns [Admin, User] for Admin caller — Admin cannot create Owners', () => {
    const opts = roleOptionsFor('Admin');
    expect(opts!).toEqual(['Admin', 'User']);
    expect(opts!).not.toContain('Owner');
  });

  it('returns [] for User / unauthenticated callers', () => {
    expect(roleOptionsFor('User')).toEqual([]);
    expect(roleOptionsFor(null)).toEqual([]);
    expect(roleOptionsFor(undefined)).toEqual([]);
  });
});

describe('AccountSection — Log out button', () => {
  it('renders a Log out button next to the current user and calls logout() on click', async () => {
    (hasRole as any).mockReturnValue(false);
    (getUserRole as any).mockReturnValue('User');

    mockFetchSequence([jsonResponse({ user: { id: 'u-self', username: 'plain', role: 'User' } })]);

    // jsdom's reload is non-configurable; stub location with a writable shim.
    const reload = vi.fn();
    const originalLocation = window.location;
    delete (window as any).location;
    (window as any).location = { ...originalLocation, reload };

    try {
      render(<AccountSection />);
      const btn = await screen.findByRole('button', { name: /log out/i });
      expect(btn!).toBeInTheDocument();

      fireEvent.click(btn as any);

      await waitFor(() => expect(logout!).toHaveBeenCalledTimes(1));
      expect(logout!).toHaveBeenCalledWith({ baseUrl: '/api' });
      await waitFor(() => expect(reload!).toHaveBeenCalledTimes(1));
    } finally {
      (window as any).location = originalLocation;
    }
  });

  it('hides the Log out button when no user is loaded', async () => {
    (hasRole as any).mockReturnValue(false);
    (getUserRole as any).mockReturnValue(null);

    // /auth/me returns no user (e.g. token expired between status probe and load)
    mockFetchSequence([jsonResponse({ user: null })]);

    render(<AccountSection />);
    await waitFor(() => expect(screen.getByText(/not authenticated/i)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
  });
});

describe('AccountSection — Grok personal credentials', () => {
  it('renders a per-user Grok section wired to /auth/me/grok-auth', async () => {
    (hasRole as any).mockReturnValue(false);
    (getUserRole as any).mockReturnValue('User');

    let grokHit = false;
    const fetchMock = mockFetchByUrl([
      {
        // The per-user Grok section's on-mount load.
        match: (u: any, m: any) => m === 'GET' && u.includes('/auth/me/grok-auth'),
        response: () => {
          grokHit = true;
          return jsonResponse({
            engine: 'grok',
            apiKey: null,
            updatedAt: null,
            hostConfigFallback: { apiKey: false },
          });
        },
      },
      {
        // Current-user probe.
        match: (u: any, m: any) => m === 'GET' && u.endsWith('/auth/me'),
        response: () => jsonResponse({ user: { id: 'u-self', username: 'plain', role: 'User' } }),
      },
      {
        // Permissive catch-all for the other child auth sections' loads so
        // their network calls don't throw and abort the render.
        match: () => true,
        response: () => jsonResponse({}),
      },
    ]);

    render(<AccountSection />);

    // MyGrokAuthSection renders "Personal Grok credentials" once its paste-key
    // getter resolves — proving AccountSection wired the dedicated Grok panel.
    expect(await screen.findByText('Personal Grok credentials')).toBeInTheDocument();
    expect(screen.getByLabelText('Grok API key')).toBeInTheDocument();
    expect(grokHit!).toBe(true);
    expect(
      (fetchMock as any).mock.calls.some(([u]: any) => String(u).includes('/auth/me/grok-auth')),
    ).toBe(true);
  });
});

describe('AccountSection — Add user button visibility', () => {
  it('hides the Add user button for role=User', async () => {
    (hasRole as any).mockReturnValue(false);
    (getUserRole as any).mockReturnValue('User');

    mockFetchSequence([jsonResponse({ user: { id: 'u-self', username: 'plain', role: 'User' } })]);

    render(<AccountSection />);
    await waitFor(() => expect(screen.getByText('plain')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /add user/i })).toBeNull();
  });

  it('shows the Add user button for role=Owner and opens the modal on click', async () => {
    (hasRole as any).mockReturnValue(true);
    (getUserRole as any).mockReturnValue('Owner');

    mockFetchSequence([
      jsonResponse({ user: { id: 'u-owner', username: 'root', role: 'Owner' } }),
      jsonResponse({
        users: [{ id: 'u-owner', username: 'root', role: 'Owner', createdAt: '2026-01-01' }],
      }),
    ]);

    render(<AccountSection />);

    const addBtn = await screen.findByRole('button', { name: /add user/i });
    expect(addBtn!).toBeInTheDocument();

    fireEvent.click(addBtn as any);

    expect(await screen.findByRole('dialog', { name: /add user/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();

    // The role select inside the modal should expose all three roles to an
    // Owner caller.
    const roleSelect = screen.getByLabelText(/^role$/i);
    const optionLabels = Array.from(roleSelect.querySelectorAll('option')).map(
      (o: any) => (o as any).value,
    );
    expect(optionLabels!).toEqual(['Owner', 'Admin', 'User']);
  });
});

// Shared fetch handlers for the on-mount loads inside PluginApiKeysSection.
function pluginSectionHandlers(extra: any = []) {
  return [
    {
      match: (u: any, m: any) => u.endsWith('/api/config') && m === 'GET',
      response: () =>
        jsonResponse({
          openaiApiKey: '',
          openaiApiKeySet: false,
          geminiApiKeySet: false,
          xaiApiKeySet: false,
          transcriptionProvider: 'xai',
        }),
    },
    {
      match: (u: any, m: any) => u.includes('/api/config/gemini-auth') && m === 'GET',
      response: () =>
        jsonResponse({
          apiKey: { configured: false, source: null, masked: null },
          activeMethod: 'none',
          oauth: { loggedIn: null },
        }),
    },
    ...extra,
  ];
}

describe('PluginApiKeysSection', () => {
  it('groups plugin API keys and describes what each provider powers', async () => {
    mockFetchByUrl(pluginSectionHandlers());

    render(<PluginApiKeysSection />);

    expect(screen.getByText('Plugin API keys')).toBeInTheDocument();
    expect(await screen.findByText('xAI API key')).toBeInTheDocument();
    // The xAI key powers both the Grok agent engine and voice transcription;
    // the description must surface the engine use so it's discoverable as
    // Grok credentials (regression: was labeled transcription-only).
    const xaiDescription = screen.getByText(/Grok \(grok-cli\) agent engine/i);
    expect(xaiDescription!).toBeInTheDocument();
    expect(xaiDescription!).toHaveTextContent(/voice transcription/i);
    expect(screen.getByText('Gemini API key')).toBeInTheDocument();
    expect(screen.getByText('Used for voice transcription and wiki RAG.')).toBeInTheDocument();
    expect(screen.getByText('OpenAI API key')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Plugin use: voice transcription only. Also used for generated session titles.',
      ),
    ).toBeInTheDocument();
    // The provider selector sits at the top of the section.
    expect(screen.getByText('Voice transcription provider')).toBeInTheDocument();
  });

  it('saves the host OpenAI API key through PATCH /api/config', async () => {
    const fetchMock = mockFetchByUrl(
      pluginSectionHandlers([
        {
          match: (u: any, m: any) => u.endsWith('/api/config') && m === 'PATCH',
          response: () => jsonResponse({ ok: true, updated: { openaiApiKey: '••••••••' } }),
        },
      ]),
    );

    render(<PluginApiKeysSection />);

    expect(await screen.findByText('OpenAI API key')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('OpenAI API key' as any), {
      target: { value: ' sk-test-openai ' },
    });
    // Key rows render in order: xAI (0), Gemini (1), OpenAI (2).
    fireEvent.click(screen.getAllByRole('button', { name: /save api key/i } as any)[2]);

    await waitFor(() =>
      expect(fetchMock!).toHaveBeenLastCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ openaiApiKey: 'sk-test-openai' }),
        }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('saves the host xAI API key through PATCH /api/config', async () => {
    const fetchMock = mockFetchByUrl(
      pluginSectionHandlers([
        {
          match: (u: any, m: any) => u.endsWith('/api/config') && m === 'PATCH',
          response: () => jsonResponse({ ok: true, updated: { xaiApiKey: '••••••••' } }),
        },
      ]),
    );

    render(<PluginApiKeysSection />);

    expect(await screen.findByText('xAI API key')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('xAI API key' as any), {
      target: { value: ' xai-test-key ' },
    });
    // Key rows render in order: xAI (0), Gemini (1), OpenAI (2).
    fireEvent.click(screen.getAllByRole('button', { name: /save api key/i } as any)[0]);

    await waitFor(() =>
      expect(fetchMock!).toHaveBeenLastCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ xaiApiKey: 'xai-test-key' }),
        }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('saves the host Gemini API key through the Gemini auth endpoint', async () => {
    const fetchMock = mockFetchByUrl(
      pluginSectionHandlers([
        {
          match: (u: any, m: any) => u.includes('/api/config/gemini-auth/api-key') && m === 'POST',
          response: () => jsonResponse({ ok: true, configured: true, masked: '••••••••test' }),
        },
      ]),
    );

    render(<PluginApiKeysSection />);

    expect(await screen.findByText('Gemini API key')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Gemini API key' as any), {
      target: { value: ' AIza-test ' },
    });
    // Key rows render in order: xAI (0), Gemini (1), OpenAI (2).
    fireEvent.click(screen.getAllByRole('button', { name: /save api key/i } as any)[1]);

    await waitFor(() =>
      expect(fetchMock!).toHaveBeenLastCalledWith(
        '/api/config/gemini-auth/api-key',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ apiKey: 'AIza-test' }),
        }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });
});

describe('TranscriptionProviderRow', () => {
  it('selects xAI Grok by default and persists it when chosen', async () => {
    const fetchMock = mockFetchByUrl([
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'GET',
        response: () =>
          jsonResponse({
            transcriptionProvider: 'xai',
            xaiApiKeySet: true,
            openaiApiKeySet: false,
            geminiApiKeySet: false,
          }),
      },
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'PATCH',
        response: () => jsonResponse({ ok: true, updated: { transcriptionProvider: 'openai' } }),
      },
    ]);

    render(<TranscriptionProviderRow />);

    const xaiOption = await screen.findByRole('radio', { name: /xAI Grok/i });
    expect(xaiOption!).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('xAI API key set')).toBeInTheDocument();

    // Switching away then back exercises the xai PATCH path.
    const openaiOption = screen.getByRole('radio', { name: /OpenAI Whisper/i });
    fireEvent.click(openaiOption as any);
    await waitFor(() =>
      expect(fetchMock!).toHaveBeenLastCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ transcriptionProvider: 'openai' }),
        }),
      ),
    );
  });

  it('renders the current provider and per-provider key status from config', async () => {
    mockFetchByUrl([
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'GET',
        response: () =>
          jsonResponse({
            transcriptionProvider: 'gemini',
            openaiApiKeySet: true,
            geminiApiKeySet: false,
          }),
      },
    ]);

    render(<TranscriptionProviderRow />);

    const geminiOption = await screen.findByRole('radio', { name: /Google Gemini/i });
    expect(geminiOption!).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /OpenAI Whisper/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // Selected provider's key is missing → warn; the other is set.
    expect(screen.getByText('Gemini API key missing')).toBeInTheDocument();
    expect(screen.getByText('OpenAI API key set')).toBeInTheDocument();
  });

  it('persists a new provider choice through PATCH /api/config', async () => {
    const fetchMock = mockFetchByUrl([
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'GET',
        response: () =>
          jsonResponse({
            transcriptionProvider: 'openai',
            openaiApiKeySet: true,
            geminiApiKeySet: true,
          }),
      },
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'PATCH',
        response: () => jsonResponse({ ok: true, updated: { transcriptionProvider: 'gemini' } }),
      },
    ]);

    render(<TranscriptionProviderRow />);

    const geminiOption = await screen.findByRole('radio', { name: /Google Gemini/i });
    fireEvent.click(geminiOption as any);

    await waitFor(() =>
      expect(fetchMock!).toHaveBeenLastCalledWith(
        '/api/config',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ transcriptionProvider: 'gemini' }),
        }),
      ),
    );
    await waitFor(() => expect(geminiOption!).toHaveAttribute('aria-checked', 'true'));
  });

  it('reverts the selection when the save fails', async () => {
    mockFetchByUrl([
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'GET',
        response: () =>
          jsonResponse({
            transcriptionProvider: 'openai',
            openaiApiKeySet: true,
            geminiApiKeySet: true,
          }),
      },
      {
        match: (u: any, m: any) => u.endsWith('/api/config') && m === 'PATCH',
        response: () => jsonResponse({ error: 'boom' }, 500),
      },
    ]);

    render(<TranscriptionProviderRow />);

    const openaiOption = await screen.findByRole('radio', { name: /OpenAI Whisper/i });
    const geminiOption = screen.getByRole('radio', { name: /Google Gemini/i });
    fireEvent.click(geminiOption as any);

    await screen.findByRole('alert');
    // Optimistic update rolled back to the original provider.
    expect(openaiOption!).toHaveAttribute('aria-checked', 'true');
  });
});
