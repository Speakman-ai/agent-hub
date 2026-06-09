import { Bot, Clock, FolderGit2 } from 'lucide-react';
import { AgentConfigSection, CronSection, ProjectsSection } from './SettingsPage.jsx';

const TAB_META = {
  agents: { label: 'Agents', Icon: Bot },
  settings: { label: 'Project settings', Icon: FolderGit2 },
  crons: { label: 'Cron Jobs', Icon: Clock },
};

/**
 * Per-project settings moved out of global Settings into the sidebar
 * "{project name} Menu" (Agents, Project settings, Cron Jobs).
 */
export default function ProjectMenuPage({
  projectId,
  project,
  tab = 'agents',
  projects = [],
  agents = [],
  onAgentsChange,
  onProjectsChange,
  onNavigate,
  showToast,
}) {
  const meta = TAB_META[tab] || TAB_META.agents;
  const Icon = meta.Icon;
  const projectName = project?.name || 'Project';
  const projectColor = project?.color || '#6366f1';

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ backgroundColor: projectColor }}
          />
          <h2 className="text-lg font-semibold text-white truncate">{projectName}</h2>
          <span className="text-gray-600">·</span>
          <span className="text-sm text-gray-400 flex items-center gap-1.5 truncate">
            <Icon size={16} className="flex-shrink-0" />
            {meta.label}
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-6">
          Project-scoped settings. Open{' '}
          <strong className="text-gray-400">{projectName} Menu</strong> in the sidebar to switch
          sections.
        </p>

        {tab === 'agents' && (
          <AgentConfigSection
            agents={agents}
            projects={projects}
            projectId={projectId}
            onAgentsChange={onAgentsChange}
            showToast={showToast}
          />
        )}
        {tab === 'settings' && (
          <ProjectsSection
            projects={projects}
            projectId={projectId}
            onProjectsChange={onProjectsChange}
            showToast={showToast}
          />
        )}
        {tab === 'crons' && (
          <CronSection
            projects={projects}
            projectId={projectId}
            onNavigate={onNavigate}
            showToast={showToast}
          />
        )}
      </div>
    </div>
  );
}

export { TAB_META };
