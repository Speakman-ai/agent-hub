/**
 * Does a PR's head commit declare a PR environment?
 *
 * When the project has saved Deployments settings, those decide (they replace
 * deploy.yaml for every commit). Otherwise the answer comes from the exact
 * head commit, never from another revision: a PR can add or remove the
 * `preview:` block relative to the default branch. A commit that cannot be
 * read is `unresolved`. Invalid YAML at the head counts as `absent`.
 */
import type { Project } from '../types.js';
import { parseDeployConfig } from '../deploy/deploy-config.js';
import { readDeployYamlAtCommit } from '../deploy/deployment-checkout.js';
import { loadStoredDeployConfig } from '../deploy/deploy-settings-lazy.js';

export type PreviewConfigProbe = 'present' | 'absent' | 'unresolved';

export async function probePreviewConfigAtSha(
  project: Project,
  headSha: string,
): Promise<PreviewConfigProbe> {
  let stored;
  try {
    stored = await loadStoredDeployConfig(project.id);
  } catch {
    return 'absent';
  }
  if (stored) return stored.preview !== null ? 'present' : 'absent';
  let raw: string | null;
  try {
    const at = await readDeployYamlAtCommit({ project, sha: headSha });
    raw = at.kind === 'present' ? at.raw : null;
  } catch {
    return 'unresolved';
  }
  if (raw == null) return 'absent';
  try {
    return parseDeployConfig(raw).preview !== null ? 'present' : 'absent';
  } catch {
    return 'absent';
  }
}

/** Boolean form for display paths (PR detail): only an exact `present` counts. */
export async function hasPreviewConfigAtSha(project: Project, headSha: string): Promise<boolean> {
  return (await probePreviewConfigAtSha(project, headSha)) === 'present';
}
