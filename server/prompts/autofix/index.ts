/**
 * Autofix prompt templates.
 *
 * These templates replace the deprecated `babysit` skill. They are loaded at
 * runtime by the event-driven autofix dispatcher (see the `autoKeepPrGreen`
 * feature) to spawn fresh sessions that respond to reviewer feedback, CI
 * failures, and merge conflicts.
 *
 * Templates live as `.md` files next to this module so the wording can be
 * edited without recompiling. They are loaded synchronously on first access
 * and cached — these files are small and the server never modifies them at
 * runtime, so a single read is safe.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AutofixKind = 'review' | 'ci' | 'conflict';

const TEMPLATE_FILES: Record<AutofixKind, string> = {
  review: 'review-autofix.md',
  ci: 'ci-autofix.md',
  conflict: 'conflict-resolve.md',
};

const cache = new Map<AutofixKind, string>();

/**
 * Load an autofix prompt template by kind.
 *
 * Throws if the template file is missing — that's a packaging bug and should
 * fail loudly rather than silently dispatching an empty prompt.
 */
export function loadAutofixTemplate(kind: AutofixKind): string {
  const cached = cache.get(kind);
  if (cached !== undefined) return cached;

  const filename = TEMPLATE_FILES[kind];
  if (!filename) {
    throw new Error(`Unknown autofix template kind: ${kind}`);
  }

  const filePath = path.join(__dirname, filename);
  const content = readFileSync(filePath, 'utf-8');
  if (!content.trim()) {
    throw new Error(`Autofix template is empty: ${filePath}`);
  }

  cache.set(kind, content);
  return content;
}

/**
 * Directory that contains the autofix templates. Exposed so tests and
 * tooling can enumerate files without re-deriving the path.
 */
export const AUTOFIX_PROMPTS_DIR: string = __dirname;

/**
 * All template kinds the loader knows about, in a stable order suitable for
 * iteration in tests.
 */
export const AUTOFIX_KINDS: readonly AutofixKind[] = ['review', 'ci', 'conflict'];

/**
 * Reset the in-memory template cache. Intended for tests that rewrite the
 * template files on disk.
 */
export function resetAutofixTemplateCache(): void {
  cache.clear();
}
