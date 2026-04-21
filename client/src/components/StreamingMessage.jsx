import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { markdownComponents } from './MarkdownRenderer.jsx';

const ENGINE_BADGES = {
  'claude-code': { dotClass: 'bg-purple-500', label: 'Claude Code' },
  'cursor-agent': { dotClass: 'bg-emerald-500', label: 'Cursor Agent' },
  'codex-cli': { dotClass: 'bg-sky-500', label: 'Codex' },
};

function StreamingMessage({ content, agentColor, engine }) {
  const engineBadge = engine ? ENGINE_BADGES[engine] : null;
  const components = markdownComponents;

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[95%] sm:max-w-[90%] bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agentColor }} />
          <span className="text-xs text-gray-500 font-medium">Assistant</span>
          {engineBadge && (
            <span
              className="text-xs text-gray-600 flex items-center gap-1"
              title={engineBadge.label}
            >
              <span className={`w-2.5 h-2.5 rounded-full inline-block ${engineBadge.dotClass}`} />
              <span className="hidden sm:inline">{engineBadge.label}</span>
            </span>
          )}
          <span className="flex items-center gap-1 ml-1">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-xs text-emerald-500">streaming</span>
          </span>
        </div>
        <div className="markdown-content text-gray-200">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={components}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export default memo(StreamingMessage);
