/**
 * FileDiffView — shared per-file unified-diff rendering, used by the
 * Repository page (commit view) and the Pull Requests detail (Files
 * changed). Splits a raw unified diff into collapsible per-file sections
 * with +/- counts and minimal syntax coloring.
 *
 * When `onAddComment` is provided (native PR detail), lines become
 * commentable: hovering shows a "+" gutter button, clicking opens an
 * inline composer, and existing `comments` render as bubbles beneath
 * their anchored line (file + line + side, GitHub-style).
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Plus, Loader2, X, MessageSquare } from 'lucide-react';
import { splitUnifiedDiff, annotateDiffLines } from '../utils/commitDiff';
import { relativePrTime } from '../utils/prFormatting';

/** Minimal unified-diff coloring: green additions, red deletions, sky hunks. */
export function patchLineClass(line: any) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-400';
  if (line.startsWith('@@')) return 'text-sky-400';
  if (line.startsWith('+')) return 'text-emerald-300';
  if (line.startsWith('-')) return 'text-red-300';
  if (line.startsWith('diff --git')) return 'text-gray-200 font-semibold';
  return 'text-gray-400';
}

/** Anchor side+line for a rendered diff line, or null when not commentable. */
function anchorFor(annotated: any) {
  if (annotated.newLine !== null) return { side: 'new', line: annotated.newLine };
  if (annotated.oldLine !== null) return { side: 'old', line: annotated.oldLine };
  return null;
}

function CommentBubble({ comment, onDelete }: any) {
  return (
    <div
      className="ml-10 my-1 bg-gray-900 border border-gray-700 rounded-lg p-2.5 font-sans"
      data-testid={`inline-comment-${comment.id}`}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <MessageSquare size={11} className="text-amber-400 flex-shrink-0" />
        <span className="text-gray-300 font-medium">@{comment.user || 'unknown'}</span>
        <span className="text-gray-600">{relativePrTime(comment.created_at)}</span>
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(comment)}
            title="Delete comment"
            className="ml-auto text-gray-600 hover:text-red-400 transition-colors"
            data-testid={`inline-comment-delete-${comment.id}`}
          >
            <X size={11} />
          </button>
        )}
      </div>
      <p className="text-xs text-gray-200 whitespace-pre-wrap mt-1">{comment.body}</p>
    </div>
  );
}

function InlineComposer({ onSubmit, onCancel }: any) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ml-10 my-1 bg-gray-900 border border-amber-700/40 rounded-lg p-2 space-y-1.5 font-sans"
      data-testid="inline-comment-composer"
    >
      <textarea
        value={text}
        onChange={(e: any) => setText(e.target.value)}
        rows={2}
        autoFocus
        placeholder="Comment on this line…"
        className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-600"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !text.trim()}
          data-testid="inline-comment-submit"
          className="flex items-center gap-1 text-[11px] bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-2 py-1 rounded transition-colors"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
          Comment
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One collapsible per-file diff block. */
export function FileDiffSection({
  section,
  defaultOpen,
  comments = [],
  onAddComment = null,
  onDeleteComment = null,
}: any) {
  const [open, setOpen] = useState(defaultOpen);
  const [composerKey, setComposerKey] = useState<any>(null);
  const commentable = typeof onAddComment === 'function';
  const annotated = open ? annotateDiffLines(section.lines) : [];

  const commentsAt = (anchor: any) =>
    anchor
      ? comments.filter((c: any) => c.side === anchor.side && Number(c.line) === anchor.line)
      : [];

  return (
    <div className="border border-gray-700/60 rounded-lg bg-gray-900/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-900/70 transition-colors rounded-lg"
        data-testid={`commit-file-${section.filename}`}
      >
        {open ? (
          <ChevronDown size={14} className="text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-gray-500 flex-shrink-0" />
        )}
        <FileDiff size={13} className="text-gray-500 flex-shrink-0" />
        <code className="text-xs text-gray-200 font-mono truncate flex-1" title={section.filename}>
          {section.filename || '(diff)'}
        </code>
        {comments.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-amber-300 flex-shrink-0">
            <MessageSquare size={10} />
            {comments.length}
          </span>
        )}
        {section.isBinary ? (
          <span className="text-[10px] text-gray-500 flex-shrink-0">binary</span>
        ) : (
          <span className="text-[11px] tabular-nums flex-shrink-0">
            <span className="text-emerald-400">+{section.additions}</span>{' '}
            <span className="text-red-400">−{section.deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="text-[11px] font-mono overflow-x-auto max-h-[560px] overflow-y-auto border-t border-gray-700/60 bg-gray-950/60 rounded-b-lg p-2">
          {annotated.map((a: any, i: any) => {
            const anchor = commentable ? anchorFor(a) : null;
            const lineComments = commentsAt(anchor);
            const key = anchor ? `${anchor.side}:${anchor.line}` : null;
            return (
              <div key={i}>
                <div className="group flex items-start">
                  {commentable && (
                    <span className="w-5 flex-shrink-0 select-none">
                      {anchor && (
                        <button
                          type="button"
                          onClick={() => setComposerKey(composerKey === key ? null : key)}
                          title={`Comment on line ${anchor.line}`}
                          data-testid={`diff-line-comment-${section.filename}-${anchor.side}-${anchor.line}`}
                          className="opacity-0 group-hover:opacity-100 text-amber-400 hover:text-amber-200 transition-opacity"
                        >
                          <Plus size={11} />
                        </button>
                      )}
                    </span>
                  )}
                  <div className={`flex-1 whitespace-pre ${patchLineClass(a.text)}`}>
                    {a.text || ' '}
                  </div>
                </div>
                {lineComments.map((c: any) => (
                  <CommentBubble key={c.id} comment={c} onDelete={onDeleteComment} />
                ))}
                {commentable && composerKey === key && key !== null && (
                  <InlineComposer
                    onSubmit={async (text: any) => {
                      await onAddComment({
                        filePath: section.filename,
                        line: anchor!.line,
                        side: anchor!.side,
                        body: text,
                      });
                      setComposerKey(null);
                    }}
                    onCancel={() => setComposerKey(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Full diff rendering: split a raw unified diff into per-file sections.
 * Sections start collapsed by default so large PRs stay scannable; pass
 * `defaultOpen` to expand every file on first render (e.g. in tests).
 * `comments` (inline review comments) are routed to their file sections.
 */
export default function FileDiffView({
  patch,
  emptyLabel = 'No changes.',
  comments = [],
  onAddComment = null,
  onDeleteComment = null,
  defaultOpen = false,
}: any) {
  const files = splitUnifiedDiff(patch);
  if (files.length === 0) {
    return <p className="text-sm text-gray-600 italic py-2">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-1.5" data-testid="file-diff-view">
      {files.map((section: any, i: any) => (
        <FileDiffSection
          key={`${section.filename}-${i}`}
          section={section}
          defaultOpen={defaultOpen}
          comments={comments.filter((c: any) => c.file_path === section.filename)}
          onAddComment={onAddComment}
          onDeleteComment={onDeleteComment}
        />
      ))}
    </div>
  );
}
