import { describe, it, expect } from 'vitest';
import {
  SESSION_MODES,
  DEFAULT_SESSION_MODE,
  isSessionMode,
  normalizeSessionMode,
  isDesignModeActive,
  isSkillBuilderModeActive,
  isSkillBuilderEligibleAgent,
  isConsultModeActive,
  isHubModeActive,
  isNonShippingSessionBehavior,
  isIsolatedModeActive,
  isShippingCompatibleSessionMode,
  defaultSessionModeForProject,
  sessionHasUsableWorktree,
} from './session-mode.js';

describe('session-mode helpers', () => {
  it('exposes the canonical mode list with chat as the default', () => {
    expect(SESSION_MODES).toEqual([
      'chat',
      'isolated',
      'design',
      'scoping',
      'skill-builder',
      'consult',
      'hub',
    ]);
    expect(DEFAULT_SESSION_MODE).toBe('chat');
    expect(SESSION_MODES).toContain(DEFAULT_SESSION_MODE);
  });

  describe('isSessionMode', () => {
    it('accepts the canonical values only', () => {
      expect(isSessionMode('chat')).toBe(true);
      expect(isSessionMode('design')).toBe(true);
      expect(isSessionMode('scoping')).toBe(true);
      expect(isSessionMode('skill-builder')).toBe(true);
      expect(isSessionMode('consult')).toBe(true);
      expect(isSessionMode('isolated')).toBe(true);
    });

    it('rejects unknown strings and non-strings', () => {
      expect(isSessionMode('build')).toBe(false);
      expect(isSessionMode('DESIGN')).toBe(false);
      expect(isSessionMode('')).toBe(false);
      expect(isSessionMode(null)).toBe(false);
      expect(isSessionMode(undefined)).toBe(false);
      expect(isSessionMode(0)).toBe(false);
      expect(isSessionMode({})).toBe(false);
    });
  });

  describe('normalizeSessionMode', () => {
    it('passes through valid modes', () => {
      expect(normalizeSessionMode('chat')).toBe('chat');
      expect(normalizeSessionMode('design')).toBe('design');
      expect(normalizeSessionMode('scoping')).toBe('scoping');
      expect(normalizeSessionMode('skill-builder')).toBe('skill-builder');
    });

    it('collapses null / undefined / unknown to the default (legacy rows)', () => {
      expect(normalizeSessionMode(null)).toBe('chat');
      expect(normalizeSessionMode(undefined)).toBe('chat');
      expect(normalizeSessionMode('deploy')).toBe('chat');
      expect(normalizeSessionMode('')).toBe('chat');
      expect(normalizeSessionMode(42)).toBe('chat');
    });
  });

  describe('isDesignModeActive', () => {
    it('is true only when the row is explicitly in design mode', () => {
      expect(isDesignModeActive({ session_mode: 'design' })).toBe(true);
    });

    it('is false for chat, legacy (null/absent), and unknown values', () => {
      expect(isDesignModeActive({ session_mode: 'chat' })).toBe(false);
      expect(isDesignModeActive({ session_mode: null })).toBe(false);
      expect(isDesignModeActive({})).toBe(false);
      expect(isDesignModeActive(null)).toBe(false);
      expect(isDesignModeActive(undefined)).toBe(false);
      expect(isDesignModeActive({ session_mode: 'whatever' })).toBe(false);
    });
  });

  describe('isSkillBuilderModeActive', () => {
    it('is true only when the row is explicitly in skill-builder mode', () => {
      expect(isSkillBuilderModeActive({ session_mode: 'skill-builder' })).toBe(true);
      expect(isSkillBuilderModeActive({ session_mode: 'design' })).toBe(false);
      expect(isSkillBuilderModeActive({ session_mode: 'chat' })).toBe(false);
    });
  });

  describe('isSkillBuilderEligibleAgent', () => {
    it('is true for a regular dev agent (no role / sub / lead)', () => {
      expect(isSkillBuilderEligibleAgent({ role: 'sub' })).toBe(true);
      expect(isSkillBuilderEligibleAgent({ role: 'lead' })).toBe(true);
      expect(isSkillBuilderEligibleAgent({})).toBe(true);
    });

    it('is false for helper roles that get the wrong prompt/role', () => {
      expect(isSkillBuilderEligibleAgent({ role: 'docs' })).toBe(false);
      expect(isSkillBuilderEligibleAgent({ role: 'reviewer' })).toBe(false);
      expect(isSkillBuilderEligibleAgent({ role: 'skill-builder' })).toBe(false);
    });

    it('is false for a missing agent', () => {
      expect(isSkillBuilderEligibleAgent(null)).toBe(false);
      expect(isSkillBuilderEligibleAgent(undefined)).toBe(false);
    });
  });

  describe('isIsolatedModeActive', () => {
    it('is true only for isolated mode rows', () => {
      expect(isIsolatedModeActive({ session_mode: 'isolated' })).toBe(true);
      expect(isIsolatedModeActive({ session_mode: 'chat' })).toBe(false);
      expect(isIsolatedModeActive({ session_mode: null })).toBe(false);
    });
  });

  describe('isShippingCompatibleSessionMode', () => {
    it('is true for chat and isolated only', () => {
      expect(isShippingCompatibleSessionMode('chat')).toBe(true);
      expect(isShippingCompatibleSessionMode('isolated')).toBe(true);
      expect(isShippingCompatibleSessionMode('design')).toBe(false);
      expect(isShippingCompatibleSessionMode('consult')).toBe(false);
      expect(isShippingCompatibleSessionMode('hub')).toBe(false);
    });
  });

  describe('isConsultModeActive', () => {
    it('is true only for consult mode rows', () => {
      expect(isConsultModeActive({ session_mode: 'consult' })).toBe(true);
      expect(isConsultModeActive({ session_mode: 'chat' })).toBe(false);
    });
  });

  describe('isHubModeActive', () => {
    it('is true only for hub mode rows', () => {
      expect(isHubModeActive({ session_mode: 'hub' })).toBe(true);
      expect(isHubModeActive({ session_mode: 'consult' })).toBe(false);
    });
  });

  describe('isNonShippingSessionBehavior', () => {
    it('covers hub, consult, and legacy ask_mode', () => {
      expect(isNonShippingSessionBehavior({ session_mode: 'hub' })).toBe(true);
      expect(isNonShippingSessionBehavior({ session_mode: 'consult' })).toBe(true);
      expect(isNonShippingSessionBehavior({ session_mode: 'chat', ask_mode: 1 })).toBe(true);
      expect(isNonShippingSessionBehavior({ session_mode: 'chat', ask_mode: 0 })).toBe(false);
    });
  });

  describe('defaultSessionModeForProject', () => {
    it('defaults workflow projects to consult and dev to chat', () => {
      expect(defaultSessionModeForProject({ mode: 'workflow' })).toBe('consult');
      expect(defaultSessionModeForProject({ mode: 'dev' })).toBe('chat');
      expect(defaultSessionModeForProject(null)).toBe('chat');
    });
  });

  describe('sessionHasUsableWorktree', () => {
    it('is true only for a non-empty worktree_path', () => {
      expect(sessionHasUsableWorktree({ worktree_path: '/tmp/wt' })).toBe(true);
    });

    it('is false for missing / null / blank worktree paths', () => {
      expect(sessionHasUsableWorktree({ worktree_path: null })).toBe(false);
      expect(sessionHasUsableWorktree({ worktree_path: '' })).toBe(false);
      expect(sessionHasUsableWorktree({ worktree_path: '   ' })).toBe(false);
      expect(sessionHasUsableWorktree({})).toBe(false);
      expect(sessionHasUsableWorktree(null)).toBe(false);
      expect(sessionHasUsableWorktree(undefined)).toBe(false);
    });
  });
});
