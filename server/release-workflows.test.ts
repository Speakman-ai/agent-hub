import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
}

describe('release workflows', () => {
  it.each(['release-all.yml', 'release-prod.yml'])(
    '%s regenerates and commits OpenAPI docs after bumping the app version',
    (workflowName) => {
      const workflow = readWorkflow(workflowName);
      const installServerDeps = workflow.indexOf(
        '\n        run: cd server && npm ci --include=dev',
      );
      const versionBump = workflow.indexOf('npm version "$BUMP" --no-git-tag-version');
      const generateOpenApi = workflow.indexOf('\n          npm run generate:openapi');
      const commitOpenApi = workflow.indexOf('docs/api/openapi.yaml');

      expect(installServerDeps).toBeGreaterThanOrEqual(0);
      expect(versionBump).toBeGreaterThanOrEqual(0);
      expect(installServerDeps).toBeLessThan(generateOpenApi);
      expect(generateOpenApi).toBeGreaterThan(versionBump);
      expect(commitOpenApi).toBeGreaterThan(generateOpenApi);
    },
  );
});
