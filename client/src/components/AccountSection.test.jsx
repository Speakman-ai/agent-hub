import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock auth + connection helpers BEFORE importing the component so the
// component picks up our mocked role + fetch base instead of touching
// localStorage / the network.
vi.mock('../utils/auth.js', () => ({
  hasRole: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
}));

import AccountSection, { roleOptionsFor } from './AccountSection.jsx';
import { hasRole, getUserRole } from '../utils/auth.js';

beforeEach(() => {
  hasRole.mockReset();
  getUserRole.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchSequence(responses) {
  const fetchMock = vi.fn();
  responses.forEach((r) => fetchMock.mockResolvedValueOnce(r));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('roleOptionsFor', () => {
  it('returns [Owner, Admin, User] for Owner caller', () => {
    expect(roleOptionsFor('Owner')).toEqual(['Owner', 'Admin', 'User']);
  });

  it('returns [Admin, User] for Admin caller — Admin cannot create Owners', () => {
    const opts = roleOptionsFor('Admin');
    expect(opts).toEqual(['Admin', 'User']);
    expect(opts).not.toContain('Owner');
  });

  it('returns [] for User / unauthenticated callers', () => {
    expect(roleOptionsFor('User')).toEqual([]);
    expect(roleOptionsFor(null)).toEqual([]);
    expect(roleOptionsFor(undefined)).toEqual([]);
  });
});

describe('AccountSection — Add user button visibility', () => {
  it('hides the Add user button for role=User', async () => {
    hasRole.mockReturnValue(false);
    getUserRole.mockReturnValue('User');

    mockFetchSequence([jsonResponse({ user: { id: 'u-self', username: 'plain', role: 'User' } })]);

    render(<AccountSection />);
    await waitFor(() => expect(screen.getByText('plain')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /add user/i })).toBeNull();
  });

  it('shows the Add user button for role=Owner and opens the modal on click', async () => {
    hasRole.mockReturnValue(true);
    getUserRole.mockReturnValue('Owner');

    mockFetchSequence([
      jsonResponse({ user: { id: 'u-owner', username: 'root', role: 'Owner' } }),
      jsonResponse({
        users: [{ id: 'u-owner', username: 'root', role: 'Owner', createdAt: '2026-01-01' }],
      }),
    ]);

    render(<AccountSection />);

    const addBtn = await screen.findByRole('button', { name: /add user/i });
    expect(addBtn).toBeInTheDocument();

    fireEvent.click(addBtn);

    expect(await screen.findByRole('dialog', { name: /add user/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();

    // The role select inside the modal should expose all three roles to an
    // Owner caller.
    const roleSelect = screen.getByLabelText(/^role$/i);
    const optionLabels = Array.from(roleSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionLabels).toEqual(['Owner', 'Admin', 'User']);
  });
});
