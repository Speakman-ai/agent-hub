import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Must be mocked before importing the component under test.
vi.mock('../utils/api.js', () => ({
  api: {
    clawhubSearch: vi.fn(),
    clawhubListSkills: vi.fn(),
    clawhubGetSkill: vi.fn(),
    clawhubGetVersions: vi.fn(),
    clawhubInstall: vi.fn(),
  },
}));

import ClawHubBrowser, { normalizeSkill } from './ClawHubBrowser.jsx';
import { api } from '../utils/api.js';

describe('ClawHubBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    api.clawhubSearch.mockResolvedValue([]);
    api.clawhubListSkills.mockResolvedValue([
      {
        slug: 'postgres-helper',
        name: 'Postgres Helper',
        description: 'Postgres-aware skill',
        latest_version: '0.4.1',
        category: 'development',
      },
    ]);
    api.clawhubGetVersions.mockResolvedValue([{ version: '0.4.1' }, { version: '0.4.0' }]);
    // Default: detail fetch resolves empty so existing tests don't need to
    // mock it. Tests exercising the merge path override per-case.
    api.clawhubGetSkill.mockResolvedValue({});
    api.clawhubInstall.mockResolvedValue({
      slug: 'postgres-helper',
      installedAt: '2026-04-17T00:00:00Z',
      path: '/tmp/skills/postgres-helper',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Advance timers (debounce) AND flush pending promises. */
  async function settle(ms = 260) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('lists skills from clawhubListSkills on mount when query is empty', async () => {
    render(
      <ClawHubBrowser
        activeAgent={{ id: 'hub-frontend', name: 'Hub Frontend' }}
        installedSlugs={new Set()}
      />,
    );

    await settle();
    expect(api.clawhubListSkills).toHaveBeenCalled();
    expect(screen.getByText('Postgres Helper')).toBeInTheDocument();
  });

  it('switches to clawhubSearch with debounced query when the user types', async () => {
    render(
      <ClawHubBrowser
        activeAgent={{ id: 'hub-frontend', name: 'Hub Frontend' }}
        installedSlugs={new Set()}
      />,
    );

    // Initial list call.
    await settle();
    expect(api.clawhubListSkills).toHaveBeenCalled();

    const input = screen.getByLabelText('Search ClawHub registry');
    fireEvent.change(input, { target: { value: 'postgres' } });

    // Before debounce expires, no new search yet.
    expect(api.clawhubSearch).not.toHaveBeenCalled();

    await settle();
    expect(api.clawhubSearch).toHaveBeenCalledWith('postgres', 50);
  });

  it('unpacks upstream `{items: [...]}` envelope', async () => {
    // Upstream `GET /api/v1/skills` returns `{items, nextCursor}`; the client
    // must handle that shape in addition to `skills[]` / `results[]`.
    api.clawhubListSkills.mockResolvedValueOnce({
      items: [
        {
          slug: 'from-items',
          name: 'From Items',
          description: 'delivered via items envelope',
        },
      ],
      nextCursor: null,
    });

    render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
    await settle();

    expect(screen.getByText('From Items')).toBeInTheDocument();
  });

  describe('trust chips', () => {
    function renderWith(skill) {
      api.clawhubListSkills.mockResolvedValueOnce([skill]);
      return render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
    }

    it('renders the star chip when stars > 0 and hides it otherwise', async () => {
      renderWith({ slug: 'with-stars', name: 'With Stars', stars: 128 });
      await settle();
      // amber star chip text is "128" (compact formatter leaves < 1000 alone)
      expect(screen.getByTitle(/128 stars/i)).toBeInTheDocument();
    });

    it('hides the star chip when stars is 0 or undefined', async () => {
      renderWith({ slug: 'no-stars', name: 'No Stars', stars: 0 });
      await settle();
      expect(screen.queryByTitle(/star/i)).not.toBeInTheDocument();
    });

    it('renders the install chip when installsAllTime > 0', async () => {
      renderWith({ slug: 'pop', name: 'Pop', installsAllTime: 2500 });
      await settle();
      expect(screen.getByTitle(/2500 installs all time/i)).toBeInTheDocument();
    });

    it('hides the install chip when installsAllTime is 0 or undefined', async () => {
      renderWith({ slug: 'unpop', name: 'Unpop', installsAllTime: 0 });
      await settle();
      expect(screen.queryByTitle(/installs all time/i)).not.toBeInTheDocument();
    });

    it('renders a green benign verdict chip', async () => {
      renderWith({ slug: 'benign-skill', name: 'Benign', verdict: 'benign' });
      await settle();
      const chips = screen.getAllByTestId('verdict-chip');
      expect(chips.length).toBeGreaterThan(0);
      expect(chips[0]).toHaveAttribute('data-verdict', 'benign');
      expect(chips[0].className).toMatch(/emerald/);
    });

    it('renders an amber suspicious verdict chip', async () => {
      renderWith({ slug: 'sus-skill', name: 'Sus', verdict: 'suspicious' });
      await settle();
      const chips = screen.getAllByTestId('verdict-chip');
      expect(chips[0]).toHaveAttribute('data-verdict', 'suspicious');
      expect(chips[0].className).toMatch(/amber/);
    });

    it('renders a red malicious verdict chip', async () => {
      renderWith({ slug: 'mal-skill', name: 'Mal', verdict: 'malicious' });
      await settle();
      const chips = screen.getAllByTestId('verdict-chip');
      expect(chips[0]).toHaveAttribute('data-verdict', 'malicious');
      expect(chips[0].className).toMatch(/red/);
    });

    it('renders no verdict chip when verdict is absent', async () => {
      renderWith({ slug: 'plain', name: 'Plain' });
      await settle();
      expect(screen.queryByTestId('verdict-chip')).not.toBeInTheDocument();
    });
  });

  describe('upstream shape normalization (regression for bug #1)', () => {
    it('renders star + install chips from nested `stats` on list responses', async () => {
      // Real upstream `/api/v1/skills/:slug` shape — stats nested, displayName
      // instead of name, summary instead of description, tags.latest instead
      // of latest_version. Before the fix these fields were ignored and chips
      // never rendered.
      api.clawhubListSkills.mockResolvedValueOnce({
        items: [
          {
            slug: 'test-runner',
            displayName: 'Test Runner',
            summary: 'Run tests everywhere.',
            tags: { latest: '1.0.0' },
            stats: { stars: 12, installsAllTime: 106, downloads: 11528 },
          },
        ],
        nextCursor: null,
      });

      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
      await settle();

      // Name comes from displayName, description from summary, version from tags.latest.
      expect(screen.getByRole('heading', { name: 'Test Runner' })).toBeInTheDocument();
      expect(screen.getByText('Run tests everywhere.')).toBeInTheDocument();
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
      // Trust chips hoisted from stats.
      expect(screen.getByTitle(/12 stars/i)).toBeInTheDocument();
      expect(screen.getByTitle(/106 installs all time/i)).toBeInTheDocument();
    });

    it('renders the verdict chip when moderation.verdict is present', async () => {
      api.clawhubListSkills.mockResolvedValueOnce([
        {
          slug: 'scanned',
          displayName: 'Scanned Skill',
          moderation: { verdict: 'benign', confidence: 0.87 },
        },
      ]);

      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
      await settle();

      const chips = screen.getAllByTestId('verdict-chip');
      expect(chips[0]).toHaveAttribute('data-verdict', 'benign');
    });

    it('prefers flat values over nested ones when both are present', () => {
      // If a caller passes { stars: 99, stats: { stars: 1 } } we should keep
      // the flat 99 — mocks in other tests rely on this and we don't want
      // nested data to shadow explicit top-level values.
      const out = normalizeSkill({ slug: 's', stars: 99, stats: { stars: 1 } });
      expect(out.stars).toBe(99);
    });

    it('preserves the value 0 so count-zero chips correctly hide', () => {
      // `?? 0` preserves the zero — important for the gating logic
      // (`stars > 0`) which must not flip to truthy.
      const out = normalizeSkill({ slug: 's', stars: 0, installsAllTime: 0 });
      expect(out.stars).toBe(0);
      expect(out.installsAllTime).toBe(0);
    });

    it('returns undefined for missing trust signals instead of null', () => {
      // `skill.stars > 0` must be false for undefined — ensuring chips hide
      // when upstream omits stats entirely (true for search responses today).
      const out = normalizeSkill({ slug: 's', displayName: 'Plain' });
      expect(out.stars).toBeUndefined();
      expect(out.installsAllTime).toBeUndefined();
      expect(out.verdict).toBeUndefined();
    });

    it('coerces object-shaped `latestVersion` to its version string', () => {
      // Upstream detail endpoint returns `latestVersion` as an object
      // `{version, createdAt, changelog, license}`. Rendering that directly
      // via `v{latest_version}` crashes React ("Objects are not valid as a
      // React child"). normalizeSkill must extract the `.version` string.
      const out = normalizeSkill({
        slug: 's',
        latestVersion: {
          version: '1.2.3',
          createdAt: '2026-04-17T00:00:00Z',
          changelog: 'bug fixes',
          license: 'MIT',
        },
      });
      expect(out.latest_version).toBe('1.2.3');
    });

    it('also coerces an object under `tags.latest`', () => {
      const out = normalizeSkill({
        slug: 's',
        tags: { latest: { version: '2.0.0', createdAt: '2026-04-17T00:00:00Z' } },
      });
      expect(out.latest_version).toBe('2.0.0');
    });

    it('returns undefined when no source yields a string version', () => {
      // Neither flat string nor an object with a string `.version` — should
      // render nothing rather than crashing on a partial object.
      const out = normalizeSkill({
        slug: 's',
        latestVersion: { createdAt: '2026-04-17T00:00:00Z' }, // no version field
      });
      expect(out.latest_version).toBeUndefined();
    });

    it('hoists llmAnalysis / vtAnalysis from moderation block', () => {
      const out = normalizeSkill({
        slug: 's',
        moderation: {
          verdict: 'benign',
          llmAnalysis: { status: 'benign', reason: 'ok' },
          vtAnalysis: { malicious: 0, total: 70 },
        },
      });
      expect(out.verdict).toBe('benign');
      expect(out.llmAnalysis).toEqual({ status: 'benign', reason: 'ok' });
      expect(out.vtAnalysis).toEqual({ malicious: 0, total: 70 });
    });
  });

  describe('expanded Security panel', () => {
    async function expandCardByName(name) {
      await settle();
      // Name renders in the <h4> header; slug can repeat below in <p>, so
      // scope the click to the heading.
      fireEvent.click(screen.getByRole('heading', { name }));
      await settle(0);
    }

    it('renders the Security section with llmAnalysis/vtAnalysis fields', async () => {
      api.clawhubListSkills.mockResolvedValueOnce([
        {
          slug: 'safe-skill',
          name: 'Safe Skill',
          verdict: 'benign',
          confidence: 0.92,
          llmAnalysis: { status: 'benign', reason: 'no suspicious calls' },
          vtAnalysis: { malicious: 0, total: 70 },
        },
      ]);
      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
      await expandCardByName('Safe Skill');

      const panel = screen.getByTestId('security-panel');
      expect(panel).toBeInTheDocument();
      expect(panel.textContent).toMatch(/confidence 92%/i);
      expect(panel.textContent).toMatch(/LLM.*benign/i);
      expect(panel.textContent).toMatch(/VirusTotal.*0\/70/i);
    });

    it('omits the Security section entirely when no security fields present', async () => {
      api.clawhubListSkills.mockResolvedValueOnce([{ slug: 'plain', name: 'Plain' }]);
      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
      await expandCardByName('Plain');

      expect(screen.queryByTestId('security-panel')).not.toBeInTheDocument();
    });
  });

  describe('detail fetch on expand (regression: search response has no stats)', () => {
    async function expandCardByName(name) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
      });
      fireEvent.click(screen.getByRole('heading', { name }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it('fetches detail + versions in parallel when a card expands', async () => {
      // Search-style flat row — no stats, no moderation.
      api.clawhubSearch.mockResolvedValueOnce([
        { slug: 'datadog-mcp', displayName: 'Datadog MCP', summary: 'Datadog observability' },
      ]);
      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);

      const input = screen.getByLabelText('Search ClawHub registry');
      fireEvent.change(input, { target: { value: 'datadog' } });
      await expandCardByName('Datadog MCP');

      expect(api.clawhubGetSkill).toHaveBeenCalledWith('datadog-mcp');
      expect(api.clawhubGetVersions).toHaveBeenCalledWith('datadog-mcp');
    });

    it('renders stars + install chips after the detail fetch resolves', async () => {
      // List row is bare (the search shape) — chips should appear only once
      // the detail endpoint fills in `stats`.
      api.clawhubListSkills.mockResolvedValueOnce([{ slug: 'datadog-mcp', name: 'Datadog MCP' }]);
      api.clawhubGetSkill.mockResolvedValueOnce({
        slug: 'datadog-mcp',
        displayName: 'Datadog MCP',
        stats: { stars: 42, installsAllTime: 1337 },
        moderation: { verdict: 'benign', confidence: 0.9 },
      });

      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);

      // Pre-expand: no chips yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
      });
      expect(screen.queryByTitle(/42 stars/i)).not.toBeInTheDocument();

      // Expand: detail fetch fires, chips appear.
      await expandCardByName('Datadog MCP');
      expect(screen.getByTitle(/42 stars/i)).toBeInTheDocument();
      expect(screen.getByTitle(/1337 installs all time/i)).toBeInTheDocument();
      const chips = screen.getAllByTestId('verdict-chip');
      expect(chips[0]).toHaveAttribute('data-verdict', 'benign');
      expect(screen.getByTestId('security-panel')).toBeInTheDocument();
    });

    it('stays usable when the detail endpoint errors', async () => {
      api.clawhubListSkills.mockResolvedValueOnce([{ slug: 'broken', name: 'Broken' }]);
      api.clawhubGetSkill.mockRejectedValueOnce(new Error('502: upstream down'));

      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
      await expandCardByName('Broken');

      // Card still renders; Version picker + install buttons still present.
      expect(screen.getByLabelText(/version/i)).toBeInTheDocument();
      // No chips, no security panel — degrades cleanly.
      expect(screen.queryByTestId('security-panel')).not.toBeInTheDocument();
    });

    it('prefers the merged detail values over the list row', async () => {
      // List row had stale stats; detail refreshes them.
      api.clawhubListSkills.mockResolvedValueOnce([{ slug: 's', name: 'S', stars: 1 }]);
      api.clawhubGetSkill.mockResolvedValueOnce({
        slug: 's',
        stats: { stars: 999 },
      });

      render(<ClawHubBrowser activeAgent={null} installedSlugs={new Set()} />);
      await expandCardByName('S');

      // Merge is `{ ...skill, ...data }`, so detail wins.
      expect(screen.getByTitle(/999 stars/i)).toBeInTheDocument();
      expect(screen.queryByTitle(/^1 star$/i)).not.toBeInTheDocument();
    });
  });

  describe('normalizeSkill — stats.downloads fallback', () => {
    it('uses stats.downloads when installsAllTime is absent', () => {
      const out = normalizeSkill({ slug: 's', stats: { downloads: 11528 } });
      expect(out.installsAllTime).toBe(11528);
    });

    it('prefers stats.installsAllTime over stats.downloads when both are set', () => {
      const out = normalizeSkill({
        slug: 's',
        stats: { installsAllTime: 100, downloads: 99999 },
      });
      expect(out.installsAllTime).toBe(100);
    });
  });
});
