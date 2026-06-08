import { describe, expect, it } from 'vitest';
import { buildComposePreviewChecklist } from './preview-compose-checklist.js';

describe('compose.preview.yml', () => {
  it('satisfies required compose preview checklist items', () => {
    const checklist = buildComposePreviewChecklist({
      workspaceDir: new URL('..', import.meta.url).pathname,
      composeFile: 'compose.preview.yml',
      entryService: 'client',
      entryPort: 80,
    });

    expect(checklist.filter((item) => item.status === 'fail')).toEqual([]);
  });
});
