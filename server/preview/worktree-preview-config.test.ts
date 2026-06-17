import { describe, it, expect } from 'vitest';
import {
  mergePreviewComposeFromWorktree,
  readWorktreePreviewCompose,
  projectWithWorktreePreviewOverride,
} from './worktree-preview-config.js';
import type { Project } from '../types.js';

const projectCompose = {
  entryService: 'client',
  entryPort: 80,
  file: 'compose.preview.yml',
  healthPath: '/',
};

describe('mergePreviewComposeFromWorktree', () => {
  it('overlays worktree live-mount fields onto the project compose', () => {
    const merged = mergePreviewComposeFromWorktree(projectCompose as never, {
      entryWorkdir: '/app',
      entrySourceDir: '.',
      shadowDirs: [],
    });
    expect(merged).toMatchObject({
      entryService: 'client', // preserved from project
      entryPort: 80,
      entryWorkdir: '/app', // from worktree
      entrySourceDir: '.',
      shadowDirs: [],
    });
  });

  it('returns the project config unchanged for a non-object worktree value', () => {
    expect(mergePreviewComposeFromWorktree(projectCompose as never, null)).toBe(projectCompose);
    expect(mergePreviewComposeFromWorktree(projectCompose as never, 'nope')).toBe(projectCompose);
  });

  it('ignores an invalid (non-absolute) entryWorkdir', () => {
    const merged = mergePreviewComposeFromWorktree(projectCompose as never, {
      entryWorkdir: 'app',
    });
    expect(merged).not.toHaveProperty('entryWorkdir');
  });

  it('ignores an entrySourceDir that is absolute or escapes with ..', () => {
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, { entrySourceDir: '/etc' }),
    ).not.toHaveProperty('entrySourceDir');
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, { entrySourceDir: '../escape' }),
    ).not.toHaveProperty('entrySourceDir');
  });

  it('ignores a non-array shadowDirs and unknown keys', () => {
    const merged = mergePreviewComposeFromWorktree(projectCompose as never, {
      shadowDirs: 'node_modules',
      bogusField: 'x',
    }) as unknown as Record<string, unknown>;
    expect(merged.shadowDirs).toBeUndefined();
    expect(merged.bogusField).toBeUndefined();
  });

  it('accepts safe relative shadowDirs', () => {
    const merged = mergePreviewComposeFromWorktree(projectCompose as never, {
      shadowDirs: ['node_modules', 'client/node_modules'],
    }) as unknown as Record<string, unknown>;
    expect(merged.shadowDirs).toEqual(['node_modules', 'client/node_modules']);
  });

  it('rejects shadowDirs containing absolute paths or `..` escapes (whole field)', () => {
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, { shadowDirs: ['/etc'] }),
    ).not.toHaveProperty('shadowDirs');
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, {
        shadowDirs: ['node_modules', '../escape'],
      }),
    ).not.toHaveProperty('shadowDirs');
  });

  it('does not let the worktree override healthPath (readiness stays project-owned)', () => {
    const merged = mergePreviewComposeFromWorktree(projectCompose as never, {
      healthPath: '/always-200',
    }) as unknown as Record<string, unknown>;
    expect(merged.healthPath).toBe('/'); // project value preserved
  });

  it('accepts a safe relative compose `file` but rejects absolute / `..` paths', () => {
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, { file: 'compose.hmr.yml' }),
    ).toMatchObject({ file: 'compose.hmr.yml' });
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, { file: '/etc/compose.yml' }),
    ).toMatchObject({ file: 'compose.preview.yml' }); // project value preserved
    expect(
      mergePreviewComposeFromWorktree(projectCompose as never, { file: '../evil.yml' }),
    ).toMatchObject({ file: 'compose.preview.yml' });
  });
});

describe('readWorktreePreviewCompose', () => {
  it('extracts prEnv.preview.compose from the worktree file', () => {
    const readFile = () =>
      JSON.stringify({ prEnv: { preview: { compose: { entryWorkdir: '/app' } } } });
    expect(readWorktreePreviewCompose('/wt', readFile)).toEqual({ entryWorkdir: '/app' });
  });

  it('returns null on read error or invalid JSON', () => {
    const throwing = () => {
      throw new Error('ENOENT');
    };
    expect(readWorktreePreviewCompose('/wt', throwing)).toBeNull();
    expect(readWorktreePreviewCompose('/wt', () => 'not json{')).toBeNull();
  });
});

describe('projectWithWorktreePreviewOverride', () => {
  const baseProject = {
    id: 'agent-hub',
    cwd: '/repo',
    prEnv: { preview: { enabled: true, compose: projectCompose } },
  } as unknown as Project;

  it('merges the worktree entryWorkdir into the project compose', () => {
    const readFile = () =>
      JSON.stringify({ prEnv: { preview: { compose: { entryWorkdir: '/app' } } } });
    const out = projectWithWorktreePreviewOverride(baseProject, '/wt', readFile);
    expect(out.prEnv?.preview?.compose).toMatchObject({
      entryService: 'client',
      entryWorkdir: '/app',
    });
    // original is not mutated
    expect(
      (baseProject.prEnv?.preview?.compose as unknown as Record<string, unknown>).entryWorkdir,
    ).toBeUndefined();
  });

  it('returns the project unchanged when there is no worktree file', () => {
    const out = projectWithWorktreePreviewOverride(baseProject, '/wt', () => {
      throw new Error('ENOENT');
    });
    expect(out).toBe(baseProject);
  });

  it('never enables previews from a worktree file (no project preview → unchanged)', () => {
    const noPreview = { id: 'x', cwd: '/r', prEnv: {} } as unknown as Project;
    const readFile = () =>
      JSON.stringify({ prEnv: { preview: { compose: { entryService: 'client' } } } });
    expect(projectWithWorktreePreviewOverride(noPreview, '/wt', readFile)).toBe(noPreview);
  });
});
