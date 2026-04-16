import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AskUserQuestion from './AskUserQuestion.jsx';

const lib = {
  question: 'Which date library should we use?',
  header: 'Library',
  multiSelect: false,
  options: [
    { label: 'date-fns', description: 'Tree-shakable, functional.' },
    { label: 'luxon', description: 'Timezone support.' },
  ],
};

const features = {
  question: 'Which features to enable?',
  header: 'Features',
  multiSelect: true,
  options: [
    { label: 'SSR', description: 'Server-side rendering.' },
    { label: 'PWA', description: 'Progressive web app.' },
    { label: 'Auth', description: 'Authentication.' },
  ],
};

const withPreview = {
  question: 'Which layout do you prefer?',
  header: 'Layout',
  multiSelect: false,
  options: [
    {
      label: 'Sidebar',
      description: 'Left sidebar nav.',
      preview: 'const Layout = () => <aside>nav</aside>;',
    },
    {
      label: 'Topbar',
      description: 'Top navigation.',
      preview: 'const Layout = () => <header>nav</header>;',
    },
  ],
};

function renderAsk(props = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <AskUserQuestion
      askId="ask-1"
      questions={props.questions ?? [lib]}
      onSubmit={onSubmit}
      submitted={props.submitted ?? false}
    />,
  );
  return { ...utils, onSubmit };
}

describe('AskUserQuestion', () => {
  it('renders the header chip and question text for each question', () => {
    renderAsk({ questions: [lib, features] });
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText(lib.question)).toBeInTheDocument();
    expect(screen.getByText('Features')).toBeInTheDocument();
    expect(screen.getByText(features.question)).toBeInTheDocument();
  });

  it('uses radios for single-select and checkboxes for multi-select', () => {
    renderAsk({ questions: [lib] });
    // All rendered inputs for the single-select question are radios (plus the Other radio).
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThanOrEqual(3); // 2 options + Other

    const { unmount } = renderAsk({ questions: [features] });
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(4); // 3 options + Other
    unmount();
  });

  it('blocks submit when no option is selected and shows inline error', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Please select an option/i)).toBeInTheDocument();
  });

  it('blocks submit when "Other" is selected with empty text', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    // Select the Other radio (aria-label "Other")
    const otherRadio = screen.getByLabelText('Other');
    fireEvent.click(otherRadio);
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/"Other" requires text/i)).toBeInTheDocument();
  });

  it('submits a formatted chat message containing agenthub:ask:answer for single-select', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    fireEvent.click(screen.getByLabelText(/date-fns/));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const text = onSubmit.mock.calls[0][0];
    expect(text).toContain('```agenthub:ask:answer');
    const json = text.match(/```agenthub:ask:answer\n([\s\S]*?)\n```/)[1];
    const payload = JSON.parse(json);
    expect(payload.answers[lib.question]).toBe('date-fns');
  });

  it('includes askId in the answer payload so it can be tied back to the picker on reload', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    fireEvent.click(screen.getByLabelText(/date-fns/));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    const text = onSubmit.mock.calls[0][0];
    const json = text.match(/```agenthub:ask:answer\n([\s\S]*?)\n```/)[1];
    const payload = JSON.parse(json);
    expect(payload.askId).toBe('ask-1');
  });

  it('builds multi-select answers as an array of labels (not a newline-joined string)', () => {
    const { onSubmit } = renderAsk({ questions: [features] });
    fireEvent.click(screen.getByLabelText(/^SSR/));
    fireEvent.click(screen.getByLabelText(/^PWA/));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    const text = onSubmit.mock.calls[0][0];
    const json = text.match(/```agenthub:ask:answer\n([\s\S]*?)\n```/)[1];
    const payload = JSON.parse(json);
    // Array preserves structure and lets the model distinguish N selections
    // from a single "Other" free-text containing a newline.
    expect(Array.isArray(payload.answers[features.question])).toBe(true);
    expect(payload.answers[features.question]).toEqual(['SSR', 'PWA']);
  });

  it('multi-select with "Other" + free text emits the free text as an array entry', () => {
    const { onSubmit } = renderAsk({ questions: [features] });
    fireEvent.click(screen.getByLabelText(/^SSR/));
    const otherBox = screen.getByPlaceholderText(/type your own answer/i);
    fireEvent.change(otherBox, { target: { value: 'Realtime' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    const text = onSubmit.mock.calls[0][0];
    const json = text.match(/```agenthub:ask:answer\n([\s\S]*?)\n```/)[1];
    const payload = JSON.parse(json);
    expect(payload.answers[features.question]).toEqual(['SSR', 'Realtime']);
  });

  it('captures "Other" free-text as the answer value', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    // Typing in the Other box should auto-select it.
    const otherBox = screen.getByPlaceholderText(/type your own answer/i);
    fireEvent.change(otherBox, { target: { value: 'dayjs' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    const text = onSubmit.mock.calls[0][0];
    const json = text.match(/```agenthub:ask:answer\n([\s\S]*?)\n```/)[1];
    const payload = JSON.parse(json);
    expect(payload.answers[lib.question]).toBe('dayjs');
  });

  it('renders side-by-side preview pane when any option has a preview', () => {
    renderAsk({ questions: [withPreview] });
    // The preview pane renders the selected option's preview as syntax-
    // highlighted code. By default the first option is focused.
    const code = screen.getByTestId('ask-preview-code');
    expect(code).toBeInTheDocument();
    expect(code.innerHTML).toContain('Layout'); // highlighted, but text is present
  });

  it('does not render preview pane when no option has a preview', () => {
    renderAsk({ questions: [lib] });
    expect(screen.queryByTestId('ask-preview-code')).not.toBeInTheDocument();
  });

  it('includes notes in the annotations map when the user writes them', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    fireEvent.click(screen.getByLabelText(/date-fns/));
    const notes = screen.getByPlaceholderText(/add context or reasoning/i);
    fireEvent.change(notes, { target: { value: 'smallest bundle' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    const text = onSubmit.mock.calls[0][0];
    const json = text.match(/```agenthub:ask:answer\n([\s\S]*?)\n```/)[1];
    const payload = JSON.parse(json);
    expect(payload.annotations[lib.question].notes).toBe('smallest bundle');
  });

  it('disables inputs and shows "Submitted" state once submitted=true', () => {
    renderAsk({ questions: [lib], submitted: true });
    expect(screen.getByText(/Answers submitted/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /submitted/i });
    expect(button).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
  });

  it('clears the error after a valid submit attempt', () => {
    const { onSubmit } = renderAsk({ questions: [lib] });
    // First attempt: no selection → error shown.
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(screen.getByText(/Please select an option/i)).toBeInTheDocument();
    // Now select and submit — error should clear and onSubmit should fire.
    fireEvent.click(screen.getByLabelText(/luxon/));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Please select an option/i)).not.toBeInTheDocument();
  });

  it('validates each question independently in a multi-question picker', () => {
    const { onSubmit } = renderAsk({ questions: [lib, features] });
    // Answer only the first question.
    const first = screen.getByText(lib.question).closest('div.rounded-md');
    fireEvent.click(within(first).getByLabelText(/date-fns/));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    // Error should point at question 2.
    expect(screen.getByText(/Question 2:/i)).toBeInTheDocument();
  });
});
