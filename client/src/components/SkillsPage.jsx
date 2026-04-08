import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api.js';
import { BookOpen, Loader2, Save, Puzzle, ClipboardList, FileText, Pencil, PenLine, Globe } from 'lucide-react';

function SkillCard({ skill, agentId }) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!fullContent) {
      setLoading(true);
      try {
        const data = await api.getSkill(agentId, skill.id);
        setFullContent(data.content);
      } catch (err) {
        setFullContent('Failed to load skill content.');
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div
        className="p-4 cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={handleExpand}
      >
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-sm text-gray-100">{skill.name}</h4>
            {skill.description && (
              <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                {skill.description}
              </p>
            )}
          </div>
          <span className="text-gray-500 text-xs ml-3 flex-shrink-0">
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-gray-700 p-4 max-h-96 overflow-y-auto">
          {loading ? (
            <p className="text-xs text-gray-500">Loading...</p>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {fullContent || ''}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ContextFilePanel({ filename, content, agentId, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditContent(content || '');
  }, [content]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveContext(agentId, filename, editContent);
      setEditing(false);
      if (onSaved) onSaved(filename, editContent);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  if (!content && content !== '') return null;

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div
        className="p-3 cursor-pointer hover:bg-gray-750 transition-colors flex items-center justify-between"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-sm font-medium text-gray-300 flex items-center gap-1.5"><FileText size={14} /> {filename}</span>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="border-t border-gray-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditing(!editing);
              }}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                editing
                  ? 'bg-blue-800/50 text-blue-400'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              <span className="flex items-center gap-1">{editing ? <><PenLine size={12} /> Editing</> : <><Pencil size={12} /> Edit</>}</span>
            </button>
            {editing && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="text-xs bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
              >
                <span className="flex items-center gap-1">{saving ? <><Loader2 size={12} className="animate-spin" /> Saving...</> : <><Save size={12} /> Save</>}</span>
              </button>
            )}
          </div>
          {editing ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 font-mono focus:outline-none focus:border-gray-600 resize-y min-h-[200px]"
              rows={15}
            />
          ) : (
            <div className="prose prose-invert prose-sm max-w-none text-xs max-h-96 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {content || '*(empty)*'}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SkillsPage({ agents }) {
  const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || null);
  const [skills, setSkills] = useState([]);
  const [context, setContext] = useState({});
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  useEffect(() => {
    if (!activeAgentId) return;

    setLoadingSkills(true);
    setLoadingContext(true);

    api
      .getSkills(activeAgentId)
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setLoadingSkills(false));

    api
      .getContext(activeAgentId)
      .then(setContext)
      .catch(() => setContext({}))
      .finally(() => setLoadingContext(false));
  }, [activeAgentId]);

  const handleContextSaved = (filename, newContent) => {
    setContext((prev) => ({ ...prev, [filename]: newContent }));
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2"><BookOpen size={20} /> Skills & Context</h2>

        {/* Agent tabs */}
        <div className="flex gap-1.5 sm:gap-2 mb-6 overflow-x-auto pb-1 -mx-1 px-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setActiveAgentId(agent.id)}
              className={`px-3 sm:px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-2 min-h-[44px] ${
                activeAgentId === agent.id
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: agent.color }}
              />
              {agent.name}
            </button>
          ))}
        </div>

        {activeAgent && (
          <>
            {/* Skills Section */}
            {(() => {
              const projectSkills = skills.filter((s) => s.source !== 'default');
              const defaultSkills = skills.filter((s) => s.source === 'default');
              return (
                <div className="mb-8">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Puzzle size={18} /> Skills
                    <span className="text-xs text-gray-500 font-normal">
                      ({skills.length} total)
                    </span>
                  </h3>
                  {loadingSkills ? (
                    <p className="text-sm text-gray-500">Loading skills...</p>
                  ) : skills.length === 0 ? (
                    <div className="bg-gray-800 rounded-xl p-6 text-center">
                      <p className="text-gray-500 text-sm">No skills installed</p>
                      <p className="text-gray-600 text-xs mt-1">
                        Add skills to{' '}
                        <code className="bg-gray-900 px-1 rounded">
                          {activeAgent.workspace}/skills/
                        </code>
                      </p>
                    </div>
                  ) : (
                    <>
                      {projectSkills.length > 0 && (
                        <div className="space-y-2 mb-6">
                          {projectSkills.map((skill) => (
                            <SkillCard key={skill.id} skill={skill} agentId={activeAgentId} />
                          ))}
                        </div>
                      )}
                      {defaultSkills.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Globe size={12} /> Default Skills
                          </h4>
                          <div className="space-y-2">
                            {defaultSkills.map((skill) => (
                              <SkillCard key={skill.id} skill={skill} agentId={activeAgentId} />
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* Context Files Section */}
            <div>
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <ClipboardList size={18} /> Context Files
                <span className="text-xs text-gray-500 font-normal">
                  (workspace identity)
                </span>
              </h3>
              {loadingContext ? (
                <p className="text-sm text-gray-500">Loading context files...</p>
              ) : Object.keys(context).length === 0 ? (
                <div className="bg-gray-800 rounded-xl p-6 text-center">
                  <p className="text-gray-500 text-sm">No context files found</p>
                  <p className="text-gray-600 text-xs mt-1">
                    Add .md files to{' '}
                    <code className="bg-gray-900 px-1 rounded">
                      {activeAgent.workspace}/
                    </code>
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(context).map(([filename, content]) => (
                    <ContextFilePanel
                      key={filename}
                      filename={filename}
                      content={content}
                      agentId={activeAgentId}
                      onSaved={handleContextSaved}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
