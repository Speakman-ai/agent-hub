import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api.js';
import ClawHubBrowser from './ClawHubBrowser.jsx';
import {
  BookOpen,
  Loader2,
  Save,
  Puzzle,
  ClipboardList,
  FileText,
  Pencil,
  PenLine,
  Download,
  Trash2,
  ExternalLink,
  Search,
  ToggleLeft,
  ToggleRight,
  Package,
  X,
  Plug,
  Check,
  Shield,
  Cloud,
} from 'lucide-react';

const CATEGORIES = [
  { id: 'all', label: 'All', color: 'gray' },
  { id: 'platform', label: 'Platform', color: 'indigo' },
  { id: 'development', label: 'Development', color: 'blue' },
  { id: 'documentation', label: 'Documentation', color: 'emerald' },
  { id: 'automation', label: 'Automation', color: 'amber' },
  { id: 'git', label: 'Git', color: 'purple' },
  { id: 'monitoring', label: 'Monitoring', color: 'rose' },
  { id: 'general', label: 'General', color: 'gray' },
];

const CATEGORY_COLORS = {
  platform: 'bg-indigo-900/40 text-indigo-400',
  development: 'bg-blue-900/40 text-blue-400',
  documentation: 'bg-emerald-900/40 text-emerald-400',
  automation: 'bg-amber-900/40 text-amber-400',
  git: 'bg-purple-900/40 text-purple-400',
  monitoring: 'bg-rose-900/40 text-rose-400',
  general: 'bg-gray-700/40 text-gray-400',
};

function CategoryBadge({ category }) {
  const cls = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{category}</span>;
}

function SkillCard({ skill, agentId, overrides, onToggle, onUninstall, isInstalled }) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(skill.content || null);
  const [loading, setLoading] = useState(false);

  const override = overrides?.find((o) => o.skill_id === skill.id);
  const isEnabled = override ? !!override.enabled : true;

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!fullContent && agentId) {
      setLoading(true);
      try {
        const data = await api.getSkill(agentId, skill.id);
        setFullContent(data.content);
      } catch {
        setFullContent('Failed to load skill content.');
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };

  return (
    <div className={`bg-gray-800 rounded-xl overflow-hidden ${!isEnabled ? 'opacity-50' : ''}`}>
      <div
        className="p-4 cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={handleExpand}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-sm text-gray-100">{skill.name}</h4>
              <CategoryBadge category={skill.category || 'general'} />
              {skill.source === 'default' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-500">
                  built-in
                </span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-gray-400 mt-1 line-clamp-2">{skill.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {onToggle && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(skill.id, !isEnabled);
                }}
                className="text-gray-400 hover:text-white transition-colors"
                title={isEnabled ? 'Disable for this agent' : 'Enable for this agent'}
              >
                {isEnabled ? (
                  <ToggleRight size={20} className="text-emerald-400" />
                ) : (
                  <ToggleLeft size={20} />
                )}
              </button>
            )}
            {onUninstall && isInstalled && skill.source !== 'default' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUninstall(skill.id);
                }}
                className="text-gray-500 hover:text-red-400 transition-colors"
                title="Uninstall"
              >
                <Trash2 size={14} />
              </button>
            )}
            <span className="text-gray-500 text-2xl leading-none flex items-center">
              {expanded ? '▲' : '▼'}
            </span>
          </div>
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

function RegistryCard({ skill, installedIds, onInstall }) {
  const [expanded, setExpanded] = useState(false);
  const isInstalled = installedIds.has(skill.id);

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div
        className="p-4 cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-sm text-gray-100">{skill.name}</h4>
              <CategoryBadge category={skill.category} />
              {skill.install_count > 0 && (
                <span className="text-[10px] text-gray-500">{skill.install_count} installs</span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-gray-400 mt-1 line-clamp-2">{skill.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isInstalled) onInstall(skill.id);
              }}
              disabled={isInstalled}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors flex items-center gap-1 ${
                isInstalled
                  ? 'bg-gray-700 text-gray-500 cursor-default'
                  : 'bg-indigo-600 text-white hover:bg-indigo-500'
              }`}
            >
              {isInstalled ? (
                'Installed'
              ) : (
                <>
                  <Download size={12} /> Install
                </>
              )}
            </button>
            <span className="text-gray-500 text-2xl leading-none flex items-center">
              {expanded ? '▲' : '▼'}
            </span>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-gray-700 p-4 max-h-96 overflow-y-auto">
          <div className="prose prose-invert prose-sm max-w-none text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {skill.content || ''}
            </ReactMarkdown>
          </div>
          {skill.author && <p className="text-xs text-gray-500 mt-3">Author: {skill.author}</p>}
          {skill.source_url && (
            <p className="text-xs text-gray-500">
              Source:{' '}
              <a
                href={skill.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:underline"
              >
                {skill.source_url}
              </a>
            </p>
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
        <span className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
          <FileText size={14} /> {filename}
        </span>
        <span className="text-gray-500 text-2xl leading-none flex items-center">
          {expanded ? '▲' : '▼'}
        </span>
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
              <span className="flex items-center gap-1">
                {editing ? (
                  <>
                    <PenLine size={12} /> Editing
                  </>
                ) : (
                  <>
                    <Pencil size={12} /> Edit
                  </>
                )}
              </span>
            </button>
            {editing && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="text-xs bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
              >
                <span className="flex items-center gap-1">
                  {saving ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> Saving...
                    </>
                  ) : (
                    <>
                      <Save size={12} /> Save
                    </>
                  )}
                </span>
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

function ImportGithubModal({ onClose, onImported }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleImport = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.importGithubSkill(url.trim());
      onImported(result);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to import');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-gray-800 rounded-xl p-6 w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <ExternalLink size={18} /> Import from GitHub
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Paste a GitHub URL to a SKILL.md file, a repo URL, or a raw file URL.
        </p>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleImport()}
          placeholder="https://github.com/user/repo/blob/main/skills/my-skill/SKILL.md"
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-indigo-500 mb-3"
          autoFocus
        />
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={loading || !url.trim()}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

function PluginSkillRow({ skill }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-3 bg-gray-900/50 rounded-lg">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-100">{skill.name}</span>
            <CategoryBadge category={skill.category || 'general'} />
            {skill.version && <span className="text-[10px] text-gray-500">v{skill.version}</span>}
          </div>
          {skill.description && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{skill.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {skill.keepCodingInstructions && (
          <span
            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 flex items-center gap-1"
            title="Persists across turns via keep-coding-instructions"
          >
            <Shield size={10} /> persistent
          </span>
        )}
      </div>
    </div>
  );
}

function PluginPanel() {
  const [pluginInfo, setPluginInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [exportName, setExportName] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState(new Set());

  useEffect(() => {
    api
      .getPluginInfo()
      .then((info) => {
        setPluginInfo(info);
        setSelectedSkills(new Set(info.skills?.map((s) => s.id) || []));
      })
      .catch(() => setPluginInfo(null))
      .finally(() => setLoading(false));
  }, []);

  const handleExport = async () => {
    if (!exportName.trim()) return;
    setExporting(true);
    setExportResult(null);
    try {
      const result = await api.exportPlugin({
        name: exportName.trim(),
        skillIds: [...selectedSkills],
      });
      setExportResult(result);
    } catch (err) {
      setExportResult({ error: err.message });
    } finally {
      setExporting(false);
    }
  };

  const toggleSkillSelection = (id) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} className="animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Bundled Plugin Info */}
      {pluginInfo && (
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-indigo-600/20 flex items-center justify-center">
                  <Plug size={20} className="text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-100">{pluginInfo.name}</h3>
                  <p className="text-xs text-gray-400">
                    v{pluginInfo.version || '1.0.0'} by {pluginInfo.author?.name || 'Agent Hub'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium px-2 py-1 rounded bg-emerald-900/40 text-emerald-400 flex items-center gap-1">
                  <Check size={10} /> Installed
                </span>
              </div>
            </div>

            {pluginInfo.description && (
              <p className="text-sm text-gray-300 mb-4">{pluginInfo.description}</p>
            )}

            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Bundled Skills ({pluginInfo.skills?.length || 0})
              </h4>
              {pluginInfo.skills?.map((skill) => (
                <PluginSkillRow key={skill.id} skill={skill} />
              ))}
            </div>
          </div>

          <div className="border-t border-gray-700 px-5 py-3 bg-gray-800/50">
            <p className="text-xs text-gray-500">
              Installed as Claude Code plugin at{' '}
              <code className="bg-gray-900 px-1.5 py-0.5 rounded text-gray-400">
                ~/.claude/plugins/local/agent-hub-skills/
              </code>
            </p>
          </div>
        </div>
      )}

      {!pluginInfo && (
        <div className="bg-gray-800 rounded-xl p-6 text-center">
          <Plug size={24} className="text-gray-600 mx-auto mb-2" />
          <p className="text-gray-500 text-sm">No bundled plugin found</p>
          <p className="text-gray-600 text-xs mt-1">
            The plugin directory is missing from the server.
          </p>
        </div>
      )}

      {/* Export as Plugin */}
      <div className="bg-gray-800 rounded-xl overflow-hidden">
        <div
          className="p-4 cursor-pointer hover:bg-gray-750 transition-colors flex items-center justify-between"
          onClick={() => setShowExport(!showExport)}
        >
          <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
            <Package size={16} /> Export Skills as Plugin
          </h3>
          <span className="text-gray-500 text-2xl leading-none flex items-center">
            {showExport ? '\u25B2' : '\u25BC'}
          </span>
        </div>

        {showExport && (
          <div className="border-t border-gray-700 p-5 space-y-4">
            <p className="text-xs text-gray-400">
              Package selected skills as a Claude Code plugin. The plugin will be installed locally
              and can be shared via the marketplace.
            </p>

            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Plugin Name</label>
              <input
                type="text"
                value={exportName}
                onChange={(e) => setExportName(e.target.value)}
                placeholder="my-custom-skills"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {pluginInfo?.skills?.length > 0 && (
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">
                  Select Skills
                </label>
                <div className="space-y-1">
                  {pluginInfo.skills.map((skill) => (
                    <label
                      key={skill.id}
                      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-gray-900/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSkills.has(skill.id)}
                        onChange={() => toggleSkillSelection(skill.id)}
                        className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                      />
                      <span className="text-sm text-gray-200">{skill.name}</span>
                      <CategoryBadge category={skill.category || 'general'} />
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleExport}
                disabled={exporting || !exportName.trim() || selectedSkills.size === 0}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {exporting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Export Plugin
              </button>
              {exportResult && !exportResult.error && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <Check size={12} /> Exported to {exportResult.path}
                </span>
              )}
              {exportResult?.error && (
                <span className="text-xs text-red-400">{exportResult.error}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Plugin format reference */}
      <div className="bg-gray-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Plugin Format Reference</h3>
        <div className="text-xs text-gray-400 space-y-2 font-mono">
          <pre className="bg-gray-900 rounded-lg p-3 overflow-x-auto">
            {`plugin-name/
\u251C\u2500\u2500 .claude-plugin/
\u2502   \u2514\u2500\u2500 plugin.json       # name, version, description, author
\u2514\u2500\u2500 skills/
    \u251C\u2500\u2500 skill-a/
    \u2502   \u2514\u2500\u2500 SKILL.md      # frontmatter: name, description, version
    \u2514\u2500\u2500 skill-b/
        \u2514\u2500\u2500 SKILL.md`}
          </pre>
          <p className="font-sans text-gray-500">
            Skills use the <code className="bg-gray-900 px-1 rounded">name</code> frontmatter field
            for stable invocation. Add{' '}
            <code className="bg-gray-900 px-1 rounded">keep-coding-instructions: true</code> to
            persist skill output across turns.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SkillsPage({ agents, projects }) {
  const [activeTab, setActiveTab] = useState('installed');
  const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || null);
  const [skills, setSkills] = useState([]);
  const [context, setContext] = useState({});
  const [registry, setRegistry] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  const [loadingRegistry, setLoadingRegistry] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showImport, setShowImport] = useState(false);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  // Derive the project from the active agent
  const currentProjectId = (() => {
    if (!activeAgent || !projects) return null;
    const proj = projects.find((p) => p.agents?.some((a) => a.id === activeAgentId));
    return proj?.id || projects[0]?.id || null;
  })();

  // Load installed skills + overrides
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
    api
      .getSkillOverrides(activeAgentId)
      .then(setOverrides)
      .catch(() => setOverrides([]));
  }, [activeAgentId]);

  // Load registry
  useEffect(() => {
    if (activeTab !== 'registry') return;
    setLoadingRegistry(true);
    const cat = categoryFilter === 'all' ? undefined : categoryFilter;
    api
      .getRegistry(cat, searchQuery || undefined)
      .then(setRegistry)
      .catch(() => setRegistry([]))
      .finally(() => setLoadingRegistry(false));
  }, [activeTab, categoryFilter, searchQuery]);

  const handleToggle = useCallback(
    async (skillId, enabled) => {
      try {
        await api.toggleSkill(activeAgentId, skillId, enabled);
        setOverrides((prev) => {
          const existing = prev.findIndex((o) => o.skill_id === skillId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], enabled: enabled ? 1 : 0 };
            return updated;
          }
          return [
            ...prev,
            { agent_id: activeAgentId, skill_id: skillId, enabled: enabled ? 1 : 0 },
          ];
        });
      } catch (err) {
        console.error('Failed to toggle skill:', err);
      }
    },
    [activeAgentId],
  );

  const handleInstall = useCallback(
    async (skillId) => {
      if (!currentProjectId) return;
      try {
        await api.installSkill(currentProjectId, skillId);
        // Refresh installed skills
        const updated = await api.getSkills(activeAgentId);
        setSkills(updated);
        // Refresh registry to update install count
        const cat = categoryFilter === 'all' ? undefined : categoryFilter;
        const reg = await api.getRegistry(cat, searchQuery || undefined);
        setRegistry(reg);
      } catch (err) {
        console.error('Failed to install skill:', err);
      }
    },
    [currentProjectId, activeAgentId, categoryFilter, searchQuery],
  );

  const handleUninstall = useCallback(
    async (skillId) => {
      if (!currentProjectId) return;
      try {
        await api.uninstallSkill(currentProjectId, skillId);
        setSkills((prev) => prev.filter((s) => s.id !== skillId));
      } catch (err) {
        console.error('Failed to uninstall:', err);
      }
    },
    [currentProjectId],
  );

  const handleContextSaved = (filename, newContent) => {
    setContext((prev) => ({ ...prev, [filename]: newContent }));
  };

  const installedIds = new Set(skills.map((s) => s.id));

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
          <BookOpen size={20} /> Skills & Context
        </h2>

        {/* Tabs: Installed | Registry */}
        <div className="flex items-center gap-1 mb-6 border-b border-gray-700 pb-0">
          <button
            onClick={() => setActiveTab('installed')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'installed'
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Puzzle size={14} /> Installed
            </span>
          </button>
          <button
            onClick={() => setActiveTab('registry')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'registry'
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Package size={14} /> Registry
            </span>
          </button>
          <button
            onClick={() => setActiveTab('plugin')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'plugin'
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Plug size={14} /> Plugin
            </span>
          </button>
          <button
            onClick={() => setActiveTab('clawhub')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'clawhub'
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Cloud size={14} /> ClawHub
            </span>
          </button>
        </div>

        {activeTab === 'installed' && (
          <>
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
                        Browse the{' '}
                        <button
                          onClick={() => setActiveTab('registry')}
                          className="text-indigo-400 hover:underline"
                        >
                          Registry
                        </button>{' '}
                        to install skills, or add them to{' '}
                        <code className="bg-gray-900 px-1 rounded">
                          {activeAgent.workspace}/skills/
                        </code>
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {skills.map((skill) => (
                        <SkillCard
                          key={skill.id}
                          skill={skill}
                          agentId={activeAgentId}
                          overrides={overrides}
                          onToggle={handleToggle}
                          onUninstall={handleUninstall}
                          isInstalled
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Context Files Section */}
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <ClipboardList size={18} /> Context Files
                    <span className="text-xs text-gray-500 font-normal">(workspace identity)</span>
                  </h3>
                  {loadingContext ? (
                    <p className="text-sm text-gray-500">Loading context files...</p>
                  ) : Object.keys(context).length === 0 ? (
                    <div className="bg-gray-800 rounded-xl p-6 text-center">
                      <p className="text-gray-500 text-sm">No context files found</p>
                      <p className="text-gray-600 text-xs mt-1">
                        Add .md files to{' '}
                        <code className="bg-gray-900 px-1 rounded">{activeAgent.workspace}/</code>
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
          </>
        )}

        {activeTab === 'registry' && (
          <>
            {/* Search + Filter bar */}
            <div className="flex flex-col sm:flex-row gap-3 mb-6">
              <div className="relative flex-1">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search skills..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-indigo-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowImport(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              >
                <ExternalLink size={14} /> Import from GitHub
              </button>
            </div>

            {/* Registry grid */}
            {loadingRegistry ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-gray-500" />
              </div>
            ) : registry.length === 0 ? (
              <div className="bg-gray-800 rounded-xl p-8 text-center">
                <p className="text-gray-500 text-sm">No skills found</p>
                <p className="text-gray-600 text-xs mt-1">
                  Try a different search or import from GitHub
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {registry.map((skill) => (
                  <RegistryCard
                    key={skill.id}
                    skill={skill}
                    installedIds={installedIds}
                    onInstall={handleInstall}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {activeTab === 'plugin' && <PluginPanel />}
        {activeTab === 'clawhub' && (
          <ClawHubBrowser
            activeAgent={activeAgent}
            installedSlugs={installedIds}
            onInstalled={async () => {
              if (!activeAgentId) return;
              try {
                const updated = await api.getSkills(activeAgentId);
                setSkills(updated);
              } catch {
                /* non-fatal — list will refresh on next tab visit */
              }
            }}
          />
        )}
      </div>

      {showImport && (
        <ImportGithubModal
          onClose={() => setShowImport(false)}
          onImported={(newSkill) => {
            setRegistry((prev) => [newSkill, ...prev]);
          }}
        />
      )}
    </div>
  );
}
