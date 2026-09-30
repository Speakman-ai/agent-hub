import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkDetails from './remarkDetails';
import { normalizeNotesMarkdown } from './notesMarkdown';
import { buildVoiceNoteMarkdown } from '@shared/utils/voiceNoteMarkdown';

function renderNote(md: string) {
  return render(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkDetails]}>
      {normalizeNotesMarkdown(md)}
    </ReactMarkdown>,
  ).container;
}

describe('remarkDetails', () => {
  it('renders a voice note as a summary plus a collapsed transcript', () => {
    const md = buildVoiceNoteMarkdown({
      summary: '**Call the vendor.**\n\n- Budget is $4k',
      transcript: 'um so I need to call the vendor about the $4k budget',
    });
    const el = renderNote(`# Notes\n\n${md}\n\nafter`);
    const details = el.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe('Voice transcript');
    expect(details!.textContent).toContain('call the vendor about the $4k budget');
    // Summary markdown stays outside the fold and renders as markdown.
    expect(el.querySelector('strong')?.textContent).toBe('Call the vendor.');
    expect(details!.contains(el.querySelector('strong'))).toBe(false);
    expect(el.textContent).not.toContain('<details>');
    expect(el.textContent).toContain('after');
  });

  it('leaves an unclosed details opener alone', () => {
    const el = renderNote('<details>\n<summary>x</summary>\n\nbody');
    expect(el.querySelector('details')).toBeNull();
    expect(el.textContent).toContain('body');
  });
});
