import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import {
  validateAndComposeSkill,
  validateSkillSlug,
  ALLOWED_SKILL_CATEGORIES,
} from './skill-write.js';

describe('validateSkillSlug', () => {
  it('accepts lowercase slugs with hyphens and digits', () => {
    expect(validateSkillSlug('my-skill-2')).toEqual({ slug: 'my-skill-2' });
  });

  it('trims surrounding whitespace', () => {
    expect(validateSkillSlug('  foo  ')).toEqual({ slug: 'foo' });
  });

  it('rejects empty input', () => {
    expect(validateSkillSlug('')).toMatchObject({ error: expect.stringContaining('required') });
  });

  it('rejects uppercase, spaces, and leading hyphen', () => {
    expect(validateSkillSlug('Foo')).toHaveProperty('error');
    expect(validateSkillSlug('foo bar')).toHaveProperty('error');
    expect(validateSkillSlug('-foo')).toHaveProperty('error');
    expect(validateSkillSlug('foo/bar')).toHaveProperty('error');
  });

  it('rejects overly long slugs', () => {
    expect(validateSkillSlug('a'.repeat(65))).toHaveProperty('error');
  });
});

describe('validateAndComposeSkill', () => {
  it('composes a valid SKILL.md with frontmatter + body', () => {
    const res = validateAndComposeSkill({
      name: 'jira-triage',
      description: 'Triage Jira issues. TRIGGER when the user mentions Jira.',
      category: 'integration',
      version: '1.0.0',
      body: '# Jira Triage\n\nDo the thing.',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slug).toBe('jira-triage');
    const parsed = matter(res.content);
    expect(parsed.data.name).toBe('jira-triage');
    expect(parsed.data.description).toContain('Triage Jira');
    expect(parsed.data.category).toBe('integration');
    expect(parsed.data.version).toBe('1.0.0');
    expect(parsed.content).toContain('# Jira Triage');
  });

  it('defaults category to general and omits version when absent', () => {
    const res = validateAndComposeSkill({ name: 'foo', description: 'bar', body: 'baz' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = matter(res.content);
    expect(parsed.data.category).toBe('general');
    expect(parsed.data.version).toBeUndefined();
    expect(parsed.data['keep-coding-instructions']).toBeUndefined();
    expect(parsed.data.credentials).toBeUndefined();
  });

  it('rejects a missing description', () => {
    const res = validateAndComposeSkill({ name: 'foo', body: 'x' });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('description') });
  });

  it('rejects an invalid slug name', () => {
    const res = validateAndComposeSkill({ name: 'Bad Name', description: 'x' });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('slug') });
  });

  it('rejects a disallowed category', () => {
    const res = validateAndComposeSkill({ name: 'foo', description: 'x', category: 'nope' });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not allowed') });
  });

  it('accepts every allowlisted category', () => {
    for (const cat of ALLOWED_SKILL_CATEGORIES) {
      const res = validateAndComposeSkill({ name: 'foo', description: 'x', category: cat });
      expect(res.ok, `category ${cat} should be valid`).toBe(true);
    }
  });

  it('validates and round-trips credentials', () => {
    const res = validateAndComposeSkill({
      name: 'foo',
      description: 'x',
      credentials: [{ name: 'EXAMPLE_API_KEY', type: 'secret', required: true }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = matter(res.content);
    expect(parsed.data.credentials).toEqual([
      expect.objectContaining({ name: 'EXAMPLE_API_KEY', type: 'secret', required: true }),
    ]);
  });

  it('rejects malformed credentials with a clear error', () => {
    const res = validateAndComposeSkill({
      name: 'foo',
      description: 'x',
      credentials: [{ name: 'not a valid env var' }],
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('credentials') });
  });

  it('rejects a body that contains its own frontmatter fence', () => {
    const res = validateAndComposeSkill({
      name: 'foo',
      description: 'x',
      body: '---\nname: sneaky\n---\nbody',
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('frontmatter') });
  });

  it('enforces expectedSlug match (PUT rename guard)', () => {
    const ok = validateAndComposeSkill({ name: 'foo', description: 'x' }, { expectedSlug: 'foo' });
    expect(ok.ok).toBe(true);

    const renamed = validateAndComposeSkill(
      { name: 'bar', description: 'x' },
      { expectedSlug: 'foo' },
    );
    expect(renamed).toMatchObject({ ok: false, error: expect.stringContaining('rename') });
  });

  it('defaults name to expectedSlug when omitted (PUT)', () => {
    const res = validateAndComposeSkill({ description: 'x' }, { expectedSlug: 'foo' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slug).toBe('foo');
  });

  describe('raw content input', () => {
    it('parses frontmatter + body from a raw SKILL.md string', () => {
      const raw =
        '---\nname: raw-skill\ndescription: From raw\ncategory: tooling\n---\n# Body\n\ntext\n';
      const res = validateAndComposeSkill({ content: raw });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.slug).toBe('raw-skill');
      const parsed = matter(res.content);
      expect(parsed.data.description).toBe('From raw');
      expect(parsed.data.category).toBe('tooling');
      expect(parsed.content).toContain('# Body');
    });

    it('lets explicit fields win over raw frontmatter', () => {
      const raw = '---\nname: ignored\ndescription: ignored\n---\nbody';
      const res = validateAndComposeSkill(
        { content: raw, name: 'override', description: 'kept' },
        { expectedSlug: 'override' },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.slug).toBe('override');
      expect(matter(res.content).data.description).toBe('kept');
    });

    it('rejects raw content whose frontmatter fails validation', () => {
      const raw = '---\nname: no-desc\n---\nbody';
      const res = validateAndComposeSkill({ content: raw });
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('description') });
    });

    it('preserves unrecognized frontmatter keys on a round-trip', () => {
      const raw = [
        '---',
        'name: keep-extras',
        'description: has extra metadata',
        'category: tooling',
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        'license: MIT',
        'model: opus',
        '---',
        '# Body',
        '',
        'text',
      ].join('\n');
      const res = validateAndComposeSkill({ content: raw });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const data = matter(res.content).data;
      // Managed keys are still present and canonical.
      expect(data.name).toBe('keep-extras');
      expect(data.description).toBe('has extra metadata');
      expect(data.category).toBe('tooling');
      // Unrecognized keys survive verbatim — no silent data loss.
      expect(data['allowed-tools']).toEqual(['Bash', 'Read']);
      expect(data.license).toBe('MIT');
      expect(data.model).toBe('opus');
    });

    it('is idempotent: composing twice keeps unknown keys stable', () => {
      const raw = '---\nname: idem\ndescription: d\nx-custom: hello\n---\nbody\n';
      const first = validateAndComposeSkill({ content: raw });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = validateAndComposeSkill({ content: first.content });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.content).toBe(first.content);
      expect(matter(second.content).data['x-custom']).toBe('hello');
    });

    it('lets an explicit structured field override a managed key while keeping extras', () => {
      const raw = '---\nname: ov\ndescription: old\nlicense: MIT\n---\nbody\n';
      const res = validateAndComposeSkill({ content: raw, description: 'new' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const data = matter(res.content).data;
      expect(data.description).toBe('new');
      expect(data.license).toBe('MIT');
    });
  });
});
