import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const createQaPlan = vi.fn();
const getEpics = vi.fn();
const getBoardCards = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    createQaPlan: (...a: unknown[]) => createQaPlan(...a),
    getEpics: (...a: unknown[]) => getEpics(...a),
    getBoardCards: (...a: unknown[]) => getBoardCards(...a),
  },
}));

import NewQaPlanDialog, {
  draftToCreateInput,
  filterCardOptions,
  isHttpUrl,
  validateQaPlanDraft,
} from './NewQaPlanDialog';

const empty = { title: '', targetUrl: '', goal: '', epicId: '', cardId: '' };

beforeEach(() => {
  createQaPlan.mockReset();
  getEpics.mockReset().mockResolvedValue([
    { id: 'e1', name: 'Payments' },
    { id: 'e2', name: 'Signup' },
  ]);
  getBoardCards.mockReset().mockResolvedValue([
    { id: 'c1', title: 'Saved card', short_id: 12, epic_id: 'e1' },
    { id: 'c2', title: 'Email verify', short_id: 140, epic_id: 'e2' },
  ]);
});

describe('draft validation', () => {
  it('requires a title and an http(s) target URL', () => {
    expect(validateQaPlanDraft(empty)).toEqual({
      title: 'Title is required',
      targetUrl: 'Target URL is required',
    });
    expect(validateQaPlanDraft({ ...empty, title: 'x', targetUrl: 'staging.example.com' })).toEqual(
      { targetUrl: 'Enter a full http:// or https:// URL' },
    );
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl(' http://localhost:3050 ')).toBe(true);
    expect(validateQaPlanDraft({ ...empty, title: 'x', targetUrl: 'https://a.example' })).toEqual(
      {},
    );
  });

  it('trims fields and sends null for unset links', () => {
    expect(
      draftToCreateInput({
        ...empty,
        title: ' T ',
        targetUrl: ' https://a.example ',
        epicId: 'e1',
      }),
    ).toEqual({ title: 'T', targetUrl: 'https://a.example', goal: '', epicId: 'e1', cardId: null });
  });

  it('filters cards by epic, title, and number, newest first', () => {
    const cards = [
      { id: 'a', title: 'Saved card', shortId: 12, epicId: 'e1' },
      { id: 'b', title: 'Email verify', shortId: 140, epicId: 'e2' },
      { id: 'c', title: 'Card art', shortId: 141, epicId: 'e1' },
    ];
    expect(filterCardOptions(cards, '', '').map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(filterCardOptions(cards, 'e1', '').map((c) => c.id)).toEqual(['c', 'a']);
    expect(filterCardOptions(cards, '', 'card').map((c) => c.id)).toEqual(['c', 'a']);
    expect(filterCardOptions(cards, '', '#14').map((c) => c.id)).toEqual(['c', 'b']);
  });
});

describe('NewQaPlanDialog', () => {
  it('shows validation errors and does not submit an invalid draft', async () => {
    render(<NewQaPlanDialog projectId="proj" onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByTestId('qa-new-target'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('qa-new-submit'));
    expect(await screen.findByText('Title is required')).toBeInTheDocument();
    expect(screen.getByTestId('qa-new-target-error')).toHaveTextContent('http');
    expect(createQaPlan).not.toHaveBeenCalled();
  });

  it('creates the plan with the picked epic and card', async () => {
    createQaPlan.mockResolvedValue({ plan: { id: 'p1' } });
    const onCreated = vi.fn();
    render(<NewQaPlanDialog projectId="proj" onClose={vi.fn()} onCreated={onCreated} />);
    await screen.findByRole('option', { name: 'Payments' });
    fireEvent.change(screen.getByTestId('qa-new-title'), { target: { value: 'Checkout' } });
    fireEvent.change(screen.getByTestId('qa-new-target'), {
      target: { value: 'https://shop.example.com' },
    });
    fireEvent.change(screen.getByTestId('qa-new-goal'), { target: { value: 'Pay' } });
    fireEvent.change(screen.getByTestId('qa-new-card'), { target: { value: 'c2' } });
    // Picking an epic the card is not in clears the card.
    fireEvent.change(screen.getByTestId('qa-new-epic'), { target: { value: 'e1' } });
    expect(screen.getByTestId('qa-new-card')).toHaveValue('');
    fireEvent.change(screen.getByTestId('qa-new-card'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByTestId('qa-new-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('p1'));
    expect(createQaPlan).toHaveBeenCalledWith('proj', {
      title: 'Checkout',
      targetUrl: 'https://shop.example.com',
      goal: 'Pay',
      epicId: 'e1',
      cardId: 'c1',
    });
  });

  it('locks the fields while the plan is being created', async () => {
    let finish!: () => void;
    createQaPlan.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ plan: { id: 'p1' } }))),
    );
    const onCreated = vi.fn();
    render(<NewQaPlanDialog projectId="proj" onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId('qa-new-title'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('qa-new-target'), {
      target: { value: 'https://a.example' },
    });
    fireEvent.click(screen.getByTestId('qa-new-submit'));
    await waitFor(() => expect(screen.getByTestId('qa-new-fields')).toBeDisabled());
    expect(screen.getByTestId('qa-new-goal')).toBeDisabled();
    finish();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('p1'));
  });

  it('shows a server error and stays open', async () => {
    createQaPlan.mockRejectedValue(new Error('Epic not found'));
    const onCreated = vi.fn();
    render(<NewQaPlanDialog projectId="proj" onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId('qa-new-title'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('qa-new-target'), {
      target: { value: 'https://a.example' },
    });
    fireEvent.click(screen.getByTestId('qa-new-submit'));
    expect(await screen.findByText('Epic not found')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId('qa-new-submit')).not.toBeDisabled();
    expect(screen.getByTestId('qa-new-fields')).not.toBeDisabled();
  });
});
