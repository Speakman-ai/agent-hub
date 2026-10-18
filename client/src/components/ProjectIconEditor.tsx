import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import ProjectIcon from './ProjectIcon';

export default function ProjectIconEditor({
  project,
  onProjectsChange,
}: {
  project: { id: string; icon?: string | null; color?: string };
  onProjectsChange?: () => void;
}) {
  const [icon, setIcon] = useState(project.icon || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setIcon(project.icon || '');
    setError('');
  }, [project.id, project.icon]);
  const save = async (value: string) => {
    setSaving(true);
    setError('');
    try {
      await api.updateProject(project.id, { icon: value.trim() || null });
      setIcon(value.trim());
      onProjectsChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save project icon');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2">
      <label htmlFor={`project-icon-${project.id}`} className="text-sm text-gray-200">
        Project icon
      </label>
      <p className="text-xs text-gray-500">
        Paste an emoji or symbol, or leave blank to use the project color.
      </p>
      <div className="flex items-center gap-3">
        <ProjectIcon project={{ ...project, icon }} />
        <input
          id={`project-icon-${project.id}`}
          aria-label="Project icon"
          value={icon}
          maxLength={32}
          disabled={saving}
          onChange={(event) => setIcon(event.target.value)}
          placeholder="Emoji or symbol"
          className="w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
        />
        <button
          type="button"
          disabled={saving}
          onClick={() => void save(icon)}
          className="text-sm text-blue-400 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save icon'}
        </button>
        <button
          type="button"
          disabled={saving || !icon}
          onClick={() => void save('')}
          className="text-sm text-gray-400 disabled:opacity-50"
        >
          Use color
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
