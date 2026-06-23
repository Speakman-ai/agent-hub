import { useState } from 'react';
import { Palette, Plus, Trash2, X } from 'lucide-react';
import { api } from '../utils/api';
import { relativeTime } from '../utils/time';
import { isDesignMigrated } from '../utils/designRedirect';

/**
 * DesignsList — top-level list of Claude Designs with a "New Design" modal.
 * Each design can be linked to 0+ projects so the Design Studio agent
 * inherits their design-system context when generating artifacts.
 */
export default function DesignsList({ designs = [], projects = [], onNavigate, onChanged }: any) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [linkedProjectIds, setLinkedProjectIds] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<any>(null);
  const [deletingId, setDeletingId] = useState<any>(null);

  const resetModal = () => {
    setShowNew(false);
    setName('');
    setLinkedProjectIds([]);
    setError(null);
  };

  const toggleProject = (projectId: any) => {
    setLinkedProjectIds((prev: any) =>
      prev.includes(projectId) ? prev.filter((id: any) => id !== projectId) : [...prev, projectId],
    );
  };

  const handleCreate = async (e: any) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const design = await api.createDesign({ name: name.trim(), linkedProjectIds });
      onChanged?.();
      resetModal();
      if (design?.id) onNavigate?.('design', design.id);
    } catch (err: any) {
      setError(err.message || 'Failed to create design');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: any, e: any) => {
    e.stopPropagation();
    if (!confirm('Delete this design? The artifact directory will be wiped.')) return;
    setDeletingId(id);
    try {
      await api.deleteDesign(id);
      onChanged?.();
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 md:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Palette size={18} className="text-purple-400" />
          <h2 className="text-sm font-semibold">Designs</h2>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors"
        >
          <Plus size={14} />
          New Design
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-4xl mx-auto">
          {designs.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-gray-600 py-20">
              <Palette size={48} className="mb-4 text-gray-700" />
              <p className="text-lg">No designs yet</p>
              <p className="text-sm mt-1 text-gray-500">
                Create a design to start chatting with the Design Studio agent
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {designs.map((d: any) => (
                <button
                  key={d.id}
                  onClick={() => onNavigate?.('design', d.id)}
                  className="group text-left bg-gray-900 hover:bg-gray-800 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors relative"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Palette size={16} className="text-purple-400 flex-shrink-0" />
                      <span className="font-semibold text-sm text-gray-100 truncate">{d.name}</span>
                      {isDesignMigrated(d) && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300 flex-shrink-0"
                          title="This design has moved to a design-mode session — opening it goes there"
                        >
                          Migrated
                        </span>
                      )}
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e: any) => handleDelete(d.id, e)}
                      onKeyDown={(e: any) => {
                        if (e.key === 'Enter' || e.key === ' ') handleDelete(d.id, e);
                      }}
                      className={`opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity cursor-pointer ${
                        deletingId === d.id ? 'opacity-100 pointer-events-none' : ''
                      }`}
                      title="Delete design"
                    >
                      <Trash2 size={14} />
                    </span>
                  </div>
                  {d.linkedProjects?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {d.linkedProjects.slice(0, 3).map((p: any) => (
                        <span
                          key={p.id}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400"
                          style={{ color: p.color || undefined }}
                        >
                          {p.name}
                        </span>
                      ))}
                      {d.linkedProjects.length > 3 && (
                        <span className="text-[10px] text-gray-600">
                          +{d.linkedProjects.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-xs text-gray-600">
                    {d.updated_at ? `Updated ${relativeTime(d.updated_at)}` : 'New'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* New Design modal */}
      {showNew && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={resetModal}
        >
          <div
            className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl w-full max-w-md"
            onClick={(e: any) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
              <h3 className="text-sm font-semibold">New Design</h3>
              <button
                onClick={resetModal}
                className="text-gray-500 hover:text-gray-300 transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                  Name
                </label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e: any) => setName(e.target.value)}
                  placeholder="e.g. Sales dashboard"
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                  Link Projects <span className="text-gray-600 normal-case">(optional)</span>
                </label>
                <p className="text-xs text-gray-600 mb-2">
                  Linked projects share their design system (colors, spacing, components) with the
                  Design Studio agent.
                </p>
                {projects.length === 0 ? (
                  <div className="text-xs text-gray-600 italic">No projects available</div>
                ) : (
                  <div className="max-h-48 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800">
                    {projects.map((p: any) => (
                      <label
                        key={p.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-800/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={linkedProjectIds.includes(p.id)}
                          onChange={() => toggleProject(p.id)}
                          className="rounded border-gray-700 bg-gray-950"
                        />
                        {p.color && (
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: p.color }}
                          />
                        )}
                        <span className="text-sm text-gray-200 truncate">{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {error && (
                <div className="text-xs text-red-400 bg-red-900/30 border border-red-900/60 rounded px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={resetModal}
                  className="text-sm text-gray-400 hover:text-gray-200 px-3 py-2 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || creating}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
