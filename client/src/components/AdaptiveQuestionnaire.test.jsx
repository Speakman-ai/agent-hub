import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdaptiveQuestionnaire from './AdaptiveQuestionnaire.jsx';
import { ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY, STEP_IDS } from '../utils/adaptiveQuestionnaire.js';

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
      fireEvent.change(input, { target: { value: 'an adaptive survey tool' } });
      expect(screen.getByTestId('aq-continue')).not.toBeDisabled();
    });

    it('keeps Continue disabled for whitespace-only description', () => {
      render(<AdaptiveQuestionnaire />);
      const input = screen.getByTestId('aq-description-input');
      fireEvent.change(input, { target: { value: '   ' } });
      expect(screen.getByTestId('aq-continue')).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/can't be empty/i);
    });

    it('Back on step 1 invokes onClose', () => {
      const onClose = vi.fn();
      render(<AdaptiveQuestionnaire onClose={onClose} />);
      fireEvent.click(screen.getByTestId('aq-back'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('later steps — idk escape hatch', () => {
    it('renders idk buttons on each step after the first', () => {
      render(
        <AdaptiveQuestionnaire
          initial={{ step: STEP_IDS.indexOf('appType'), description: 'thing' }}
        />,
      );
      expect(screen.getByTestId('aq-idk')).toBeInTheDocument();
    });

    it('allows picking idk to advance the app-type step', () => {
      render(
        <AdaptiveQuestionnaire
          initial={{ step: STEP_IDS.indexOf('appType'), description: 'thing' }}
        />,
      );
      expect(screen.getByTestId('aq-continue')).toBeDisabled();
      fireEvent.click(screen.getByTestId('aq-idk'));
      expect(screen.getByTestId('aq-continue')).not.toBeDisabled();
    });
  });

  describe('stack recommendation', () => {
    it('pre-selects the recommended stack when app type is chosen', () => {
      render(
        <AdaptiveQuestionnaire
          initial={{ step: STEP_IDS.indexOf('appType'), description: 'thing' }}
        />,
      );
      fireEvent.click(screen.getByTestId('aq-apptype-web-app'));
      fireEvent.click(screen.getByTestId('aq-continue'));
      // Now on stack step — the recommended option should be selected (visible Check marker)
      const rec = screen.getByTestId('aq-stack-react-vite-express-sqlite');
      expect(rec).toHaveClass(/border-emerald-500/);
    });
  });

  describe('conditional auth step', () => {
    it('skips auth when integrations does not include auth', () => {
      render(
        <AdaptiveQuestionnaire
          initial={{
            step: STEP_IDS.indexOf('integrations'),
            description: 'thing',
            appType: 'web-app',
            stack: 'react-vite-express-sqlite',
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('aq-integration-github'));
      fireEvent.click(screen.getByTestId('aq-continue'));
      // Should land on hosting, not auth
      expect(
        screen.getByRole('heading', { name: /where should your code live/i }),
      ).toBeInTheDocument();
      // …and hosting → identity.
      fireEvent.click(screen.getByTestId('aq-hosting-agenthub'));
      fireEvent.click(screen.getByTestId('aq-continue'));
      expect(screen.getByRole('heading', { name: /name & visibility/i })).toBeInTheDocument();
    });

    it('shows auth step when auth integration is selected', () => {
      render(
        <AdaptiveQuestionnaire
          initial={{
            step: STEP_IDS.indexOf('integrations'),
            description: 'thing',
            appType: 'web-app',
            stack: 'react-vite-express-sqlite',
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('aq-integration-auth'));
      fireEvent.click(screen.getByTestId('aq-continue'));
      expect(
        screen.getByRole('heading', { name: /how should users sign in/i }),
      ).toBeInTheDocument();
    });
  });

  describe('draft persistence', () => {
    it('persists the draft to sessionStorage as the user types', () => {
      vi.useFakeTimers();
      try {
        render(<AdaptiveQuestionnaire />);
        const input = screen.getByTestId('aq-description-input');
        fireEvent.change(input, { target: { value: 'persisted desc' } });
        vi.advanceTimersByTime(500);
        const raw = sessionStorage.getItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
        expect(raw).toBeTruthy();
        expect(JSON.parse(raw).description).toBe('persisted desc');
      } finally {
        vi.useRealTimers();
      }
    });

    it('restores a persisted draft when mounted fresh', () => {
      sessionStorage.setItem(
        ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY,
        JSON.stringify({
          v: 1,
          step: 0,
          description: 'restored value',
          appType: null,
          stack: null,
          integrations: null,
          authDetail: null,
          name: '',
          visibility: null,
        }),
      );
      render(<AdaptiveQuestionnaire />);
      expect(screen.getByTestId('aq-description-input')).toHaveValue('restored value');
    });
  });

  describe('final submit', () => {
    it('submits a provisioning payload on the review step', () => {
      const onSubmit = vi.fn();
      render(
        <AdaptiveQuestionnaire
          onSubmit={onSubmit}
          initial={{
            step: STEP_IDS.indexOf('review'),
            description: 'a thing',
            appType: 'web-app',
            stack: 'react-vite-express-sqlite',
            integrations: ['github'],
            authDetail: null,
            name: 'acme',
            visibility: 'private',
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('aq-submit'));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      const payload = onSubmit.mock.calls[0][0];
      expect(payload).toMatchObject({
        version: 1,
        description: 'a thing',
        appType: 'web-app',
        integrations: ['github'],
        name: 'acme',
        visibility: 'private',
      });
      // And the draft should be cleared so the next wizard open is fresh
      expect(sessionStorage.getItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY)).toBeNull();
    });
  });
});
