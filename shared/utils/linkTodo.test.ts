import { describe, it, expect } from 'vitest';
import {
  LINK_TARGET_TYPES,
  DEFAULT_LINK_TARGET_TYPE,
  LINK_TARGET_LABELS,
  linkPayloadNeedsProject,
  normalizeLinkOptions,
  agentsForProject,
  filterLinkOptions,
  buildLinkPayload,
  canSubmitLink,
} from './linkTodo';

describe('linkTodo helper', () => {
  describe('constants', () => {
    it('lists card, epic, session in picker order with card as default', () => {
      expect(LINK_TARGET_TYPES).toEqual(['card', 'epic', 'session']);
      expect(DEFAULT_LINK_TARGET_TYPE).toBe('card');
    });

    it("labels 'card' as Ticket to match the link badge wording", () => {
      expect(LINK_TARGET_LABELS.card).toBe('Ticket');
      expect(LINK_TARGET_LABELS.epic).toBe('Epic');
      expect(LINK_TARGET_LABELS.session).toBe('Session');
    });
  });

  describe('linkPayloadNeedsProject', () => {
    it('is true for project-scoped card/epic and false for session', () => {
      expect(linkPayloadNeedsProject('card')).toBe(true);
      expect(linkPayloadNeedsProject('epic')).toBe(true);
      expect(linkPayloadNeedsProject('session')).toBe(false);
    });
  });

  describe('normalizeLinkOptions', () => {
    it('reads name then title, stringifying ids', () => {
      const rows = [
        { id: 1, title: 'Card One' }, // card → title
        { id: 'e2', name: 'Epic Two' }, // epic → name
      ];
      expect(normalizeLinkOptions(rows)).toEqual([
        { id: '1', name: 'Card One' },
        { id: 'e2', name: 'Epic Two' },
      ]);
    });

    it('prefers name over title when both present', () => {
      expect(normalizeLinkOptions([{ id: 'a', name: 'N', title: 'T' }])).toEqual([
        { id: 'a', name: 'N' },
      ]);
    });

    it('falls back to the id when no usable name field', () => {
      expect(normalizeLinkOptions([{ id: 'abc' }, { id: 'x', name: '   ' }])).toEqual([
        { id: 'abc', name: 'abc' },
        { id: 'x', name: 'x' },
      ]);
    });

    it('drops non-objects and rows without an id', () => {
      const rows = [null, 'nope', 42, {}, { id: '' }, { id: 'ok', name: 'Ok' }];
      expect(normalizeLinkOptions(rows as unknown[])).toEqual([{ id: 'ok', name: 'Ok' }]);
    });

    it('returns [] for non-array input', () => {
      expect(normalizeLinkOptions(undefined)).toEqual([]);
      expect(normalizeLinkOptions(null)).toEqual([]);
      expect(normalizeLinkOptions({})).toEqual([]);
    });
  });

  describe('agentsForProject', () => {
    const agents = [
      { id: 'a1', name: 'Dev', projectId: 'proj-x' },
      { id: 'a2', name: 'Docs', projectId: 'proj-y' },
      { id: 'a3', name: 'Rev', projectId: 'proj-x' },
      { id: 'a4', name: 'Orphan' }, // no projectId
    ];

    it('keeps only agents on the given project', () => {
      expect(agentsForProject(agents, 'proj-x')).toEqual([
        { id: 'a1', name: 'Dev' },
        { id: 'a3', name: 'Rev' },
      ]);
    });

    it('matches numeric project ids as strings', () => {
      const numeric = [{ id: 'a', name: 'A', projectId: 7 }];
      expect(agentsForProject(numeric, '7')).toEqual([{ id: 'a', name: 'A' }]);
    });

    it('returns [] for a blank project id or non-array', () => {
      expect(agentsForProject(agents, '')).toEqual([]);
      expect(agentsForProject(undefined, 'proj-x')).toEqual([]);
    });
  });

  describe('filterLinkOptions', () => {
    const opts = [
      { id: '1', name: 'Fix login bug' },
      { id: '2', name: 'Add dashboard' },
      { id: 'abc', name: 'Refactor' },
    ];

    it('returns the list unchanged for a blank query', () => {
      expect(filterLinkOptions(opts, '   ')).toEqual(opts);
    });

    it('matches on name case-insensitively', () => {
      expect(filterLinkOptions(opts, 'BUG')).toEqual([{ id: '1', name: 'Fix login bug' }]);
    });

    it('matches on id as a fallback', () => {
      expect(filterLinkOptions(opts, 'abc')).toEqual([{ id: 'abc', name: 'Refactor' }]);
    });
  });

  describe('buildLinkPayload', () => {
    it('includes projectId for a card target', () => {
      expect(buildLinkPayload({ targetType: 'card', targetId: 'c1', projectId: 'proj-x' })).toEqual(
        { targetType: 'card', targetId: 'c1', projectId: 'proj-x' },
      );
    });

    it('includes projectId for an epic target', () => {
      expect(buildLinkPayload({ targetType: 'epic', targetId: 'e1', projectId: 'proj-x' })).toEqual(
        { targetType: 'epic', targetId: 'e1', projectId: 'proj-x' },
      );
    });

    it('omits projectId entirely for a session target', () => {
      const payload = buildLinkPayload({
        targetType: 'session',
        targetId: 's1',
        projectId: 'proj-x',
      });
      expect(payload).toEqual({ targetType: 'session', targetId: 's1' });
      expect('projectId' in payload).toBe(false);
    });
  });

  describe('canSubmitLink', () => {
    const base = { submitting: false, loading: false };

    it('requires a project for a card/epic target', () => {
      expect(canSubmitLink({ ...base, targetType: 'card', targetId: 'c1', projectId: '' })).toBe(
        false,
      );
      expect(
        canSubmitLink({ ...base, targetType: 'card', targetId: 'c1', projectId: 'proj-x' }),
      ).toBe(true);
    });

    it('does not require a project for a session target', () => {
      expect(canSubmitLink({ ...base, targetType: 'session', targetId: 's1' })).toBe(true);
    });

    it('always requires a chosen target id', () => {
      expect(canSubmitLink({ ...base, targetType: 'session', targetId: '' })).toBe(false);
      expect(
        canSubmitLink({ ...base, targetType: 'card', targetId: '', projectId: 'proj-x' }),
      ).toBe(false);
    });

    it('is false while submitting or loading', () => {
      expect(
        canSubmitLink({
          targetType: 'session',
          targetId: 's1',
          submitting: true,
          loading: false,
        }),
      ).toBe(false);
      expect(
        canSubmitLink({
          targetType: 'session',
          targetId: 's1',
          submitting: false,
          loading: true,
        }),
      ).toBe(false);
    });
  });
});
