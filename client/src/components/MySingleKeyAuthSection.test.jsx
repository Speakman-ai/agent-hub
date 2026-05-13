import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Terminal } from 'lucide-react';

import MySingleKeyAuthSection from './MySingleKeyAuthSection.jsx';

function baseAuth(overrides = {}) {
  return {
    engine: 'cursor',
    apiKey: null,
    updatedAt: '2026-05-12T00:00:00.000Z',
    hostConfigFallback: { apiKey: false },
    ...overrides,
  };
}

beforeEach(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MySingleKeyAuthSection — load + render', () => {
  it('renders masked key and "Using yours" chip when user has set their own key', async () => {
    const getter = vi.fn().mockResolvedValue(baseAuth({ apiKey: '****key-tail' }));
    const setter = vi.fn();

    render(
      <MySingleKeyAuthSection
        engineLabel="Cursor"
        Icon={Terminal}
        placeholder="cursor-..."
        getter={getter}
        setter={setter}
      />,
    );

    expect(await screen.findByText('****key-tail')).toBeInTheDocument();
    expect(screen.getByText(/using yours/i)).toBeInTheDocument();
  });

  it('shows "Host fallback" when user empty but host has a value', async () => {
    const getter = vi.fn().mockResolvedValue(baseAuth({ hostConfigFallback: { apiKey: true } }));

    render(<MySingleKeyAuthSection engineLabel="Gemini" getter={getter} setter={vi.fn()} />);

    expect(await screen.findByText(/host fallback/i)).toBeInTheDocument();
  });

  it('shows "Not configured" when neither user nor host has a value', async () => {
    const getter = vi.fn().mockResolvedValue(baseAuth());

    render(<MySingleKeyAuthSection engineLabel="Codex" getter={getter} setter={vi.fn()} />);

    expect(await screen.findByText(/not configured/i)).toBeInTheDocument();
  });

  it('degrades gracefully on 401 (legacy global apiKey path)', async () => {
    const getter = vi.fn().mockRejectedValue(new Error('401: Authentication required'));

    render(<MySingleKeyAuthSection engineLabel="Cursor" getter={getter} setter={vi.fn()} />);

    expect(await screen.findByText(/sign in as a user/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
  });

  it('shows a retry button on non-401 load errors', async () => {
    const getter = vi
      .fn()
      .mockRejectedValueOnce(new Error('500: boom'))
      .mockResolvedValueOnce(baseAuth());

    render(<MySingleKeyAuthSection engineLabel="Cursor" getter={getter} setter={vi.fn()} />);

    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    await waitFor(() => expect(getter).toHaveBeenCalledTimes(2));
  });
});

describe('MySingleKeyAuthSection — save flows', () => {
  it('PUTs only { apiKey } on save', async () => {
    const getter = vi.fn().mockResolvedValue(baseAuth());
    const setter = vi.fn().mockResolvedValue(baseAuth({ apiKey: '****new' }));

    render(
      <MySingleKeyAuthSection
        engineLabel="Cursor"
        placeholder="cursor-..."
        getter={getter}
        setter={setter}
      />,
    );

    const input = await screen.findByPlaceholderText('cursor-...');
    fireEvent.change(input, { target: { value: 'curs-key-123' } });
    fireEvent.click(screen.getByRole('button', { name: /save api key/i }));

    await waitFor(() => expect(setter).toHaveBeenCalledTimes(1));
    expect(setter).toHaveBeenCalledWith({ apiKey: 'curs-key-123' });
  });

  it('Clear button PUTs apiKey: "" to clear the field', async () => {
    const getter = vi.fn().mockResolvedValue(baseAuth({ apiKey: '****existing' }));
    const setter = vi.fn().mockResolvedValue(baseAuth());

    render(<MySingleKeyAuthSection engineLabel="Gemini" getter={getter} setter={setter} />);

    const clearBtn = await screen.findByRole('button', { name: /clear my gemini api key/i });
    fireEvent.click(clearBtn);

    await waitFor(() => expect(setter).toHaveBeenCalledTimes(1));
    expect(setter).toHaveBeenCalledWith({ apiKey: '' });
  });

  it('shows the error message in an alert when PUT rejects', async () => {
    const getter = vi.fn().mockResolvedValue(baseAuth());
    const setter = vi.fn().mockRejectedValue(new Error('500: server fell over'));

    render(
      <MySingleKeyAuthSection
        engineLabel="Codex"
        placeholder="sk-..."
        getter={getter}
        setter={setter}
      />,
    );

    fireEvent.change(await screen.findByPlaceholderText('sk-...'), {
      target: { value: 'sk-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save api key/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent || '').toMatch(/server fell over/);
  });
});
