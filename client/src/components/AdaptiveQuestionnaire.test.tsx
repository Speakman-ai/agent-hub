import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdaptiveQuestionnaire from './AdaptiveQuestionnaire';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY, STEP_IDS } from '@shared/utils/adaptiveQuestionnaire';

describe('AdaptiveQuestionnaire', () => {
  beforeEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
  });

  afterEach(() => {
    sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  describe('step 1 — description (required)', () => {
    it('starts on the description step with Continue disabled', () => {
      render(<AdaptiveQuestionnaire />);
      expect(screen.getByTestId('adaptive-questionnaire')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'What are you building?' })).toBeInTheDocument();
      expect(screen.getByTestId('aq-continue')).toBeDisabled();
    });

    it('does NOT render an idk escape hatch on step 1', () => {
      render(<AdaptiveQuestionnaire />);
      expect(screen.queryByTestId('aq-idk')).not.toBeInTheDocument();
    });

    it('enables Continue once a non-empty description is entered', () => {
      render(<AdaptiveQuestionnaire />);
      const input = screen.getByTestId('aq-description-input');
      fireEvent.change(input, { target: { value: 'an adaptive survey tool' } } as any);
      expect(screen.getByTestId('aq-continue')).not.toBeDisabled();
    });

    it('keeps Continue disabled for whitespace-only description', () => {
      render(<AdaptiveQuestionnaire />);
      const input = screen.getByTestId('aq-description-input');
      fireEvent.change(input, { target: { value: '   ' } } as any);
      expect(screen.getByTestId('aq-continue')).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/can't be empty/i);
    });

    it('Back on step 1 invokes onClose', () => {
      const onClose = vi.fn();
      render(<AdaptiveQuestionnaire onClose={onClose} />);
      fireEvent.click(screen.getByTestId('aq-back' as any) as any);
      expect(onClose!).toHaveBeenCalledTimes(1);
    });
  });

  describe('hosting step', () => {
    it('renders idk and pre-selects Agent Hub', () => {
      render(
        <AdaptiveQuestionnaire
          initial={{ step: STEP_IDS.indexOf('hosting'), description: 'thing' }}
        />,
      );
      expect(screen.getByTestId('aq-idk')).toBeInTheDocument();
      expect(screen.getByTestId('aq-continue')).not.toBeDisabled();
      expect(screen.getByTestId('aq-hosting-agenthub')).toHaveClass(/border-emerald-500/);
    });
  });

  describe('draft persistence', () => {
    it('persists the draft to sessionStorage as the user types', () => {
      vi.useFakeTimers();
      try {
        render(<AdaptiveQuestionnaire />);
        const input = screen.getByTestId('aq-description-input');
        fireEvent.change(input, { target: { value: 'persisted desc' } } as any);
        vi.advanceTimersByTime(500);
        const raw = sessionStorage.getItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
        expect(raw!).toBeTruthy();
        expect(JSON.parse(raw!).description).toBe('persisted desc');
      } finally {
        vi.useRealTimers();
      }
    });

    it('restores a persisted v2 draft when mounted fresh', () => {
      sessionStorage.setItem(
        ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY,
        JSON.stringify({
          v: 2,
          step: 0,
          description: 'restored value',
          hosting: 'agenthub',
          name: '',
          visibility: null,
        }),
      );
      render(<AdaptiveQuestionnaire />);
      expect(screen.getByTestId('aq-description-input')).toHaveValue('restored value');
    });
  });

  describe('final submit', () => {
    it('submits a description-first provisioning payload on the review step', () => {
      const onSubmit = vi.fn();
      render(
        <AdaptiveQuestionnaire
          onSubmit={onSubmit}
          initial={{
            step: STEP_IDS.indexOf('review'),
            description: 'a python CLI that greets people',
            hosting: 'agenthub',
            name: 'acme',
            visibility: 'private',
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('aq-submit' as any) as any);
      expect(onSubmit!).toHaveBeenCalledTimes(1);
      const payload = (onSubmit as any).mock.calls[0][0];
      expect(payload!).toMatchObject({
        version: 2,
        description: 'a python CLI that greets people',
        appType: 'idk',
        stack: 'idk',
        name: 'acme',
        visibility: 'private',
        hostOnAgentHub: true,
      });
      expect(sessionStorage.getItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY)).toBeNull();
    });
  });
});
