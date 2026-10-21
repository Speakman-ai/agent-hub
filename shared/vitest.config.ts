import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  test: {
    // Finalize test inventory (see ci.yaml): name each JUnit testcase by its
    // repo-relative file so a report maps back to the file a session ran.
    // ci.yaml turns the reporter on from the CLI; this only supplies its
    // options. The key is omitted outside Finalize because an explicit
    // `reporters: undefined` crashes vitest startup.
    ...(process.env.FINALIZE_JUNIT_DIR
      ? {
          reporters: [
            'default',
            ['junit', { classnameTemplate: ({ filepath }) => path.relative(repoRoot, filepath) }],
          ],
        }
      : {}),
  },
});
