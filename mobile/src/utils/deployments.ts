export const DEPLOYMENT_TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled']);

export function isTerminalDeploymentStatus(status: any) {
  return DEPLOYMENT_TERMINAL_STATUSES.has(String(status || ''));
}

export function shortDeploymentRef(ref: any) {
  const s = String(ref || '');
  if (!s) return '-';
  return s.length > 12 ? s.slice(0, 12) : s;
}

function releaseVersionRef(ref: any) {
  const value = String(ref || '');
  return value.startsWith('refs/tags/') ? value.slice('refs/tags/'.length) : value;
}

export function releaseVersionDeployments(deployments: any[] = []) {
  return deployments.filter((deployment) => deployment?.status === 'success');
}

export function releaseVersionLabel(deployment: any) {
  const ref = releaseVersionRef(deployment?.ref) || deployment?.id || 'release';
  const environment = deployment?.environment || 'environment';
  return `${ref} · ${environment}`;
}

export async function loadReleaseVersionDeployments(loadHistory: () => Promise<any>) {
  try {
    const history = await loadHistory();
    return releaseVersionDeployments(history?.deployments || []);
  } catch {
    return [];
  }
}

export function mergeDeploymentConfigWithSnapshot(config: any, snapshot: any) {
  const deployment = snapshot?.deployment;
  if (!config || !deployment) return config;
  const terminal = isTerminalDeploymentStatus(deployment.status);

  return {
    ...config,
    environments: (config.environments || []).map((env: any) => {
      if (env.name !== deployment.environment) return env;
      const currentDeployment =
        deployment.status === 'success' ? deployment : (env.currentDeployment ?? null);

      return {
        ...env,
        activeDeploymentId: terminal ? null : deployment.id,
        activeDeployment: terminal ? null : deployment,
        currentRef: deployment.status === 'success' ? deployment.ref : env.currentRef,
        currentDeploymentId:
          deployment.status === 'success' ? deployment.id : env.currentDeploymentId,
        currentDeployment,
        lastDeployment: deployment,
        rollbackTarget:
          deployment.status === 'success' && env.currentDeployment?.id !== deployment.id
            ? env.currentDeployment
            : env.rollbackTarget,
      };
    }),
  };
}

export function preferredDeploymentFromConfig(config: any) {
  for (const env of config?.environments || []) {
    if (env.activeDeployment) return env.activeDeployment;
  }
  for (const env of config?.environments || []) {
    if (env.lastDeployment) return env.lastDeployment;
  }
  return null;
}

export function isMissingDeployConfigError(err: any) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('deploy.yaml not found');
}

export function deploymentEventFromSnapshot(snapshot: any, at = new Date().toISOString()) {
  const deployment = snapshot?.deployment;
  if (!deployment) return null;
  return {
    id: `${deployment.id}-${deployment.status}-${at}`,
    deploymentId: deployment.id,
    environment: deployment.environment,
    status: deployment.status,
    ref: deployment.ref,
    at,
  };
}

function valueText(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDeploymentLogEntry(entry: any): string {
  if (entry == null) return '';
  if (Array.isArray(entry)) return entry.map(formatDeploymentLogEntry).filter(Boolean).join('\n');
  if (typeof entry !== 'object') return valueText(entry);

  const stream = entry.stream ?? entry.channel;
  const directText =
    entry.text ??
    entry.message ??
    entry.line ??
    entry.content ??
    entry.output ??
    entry.data ??
    null;
  if (directText != null) {
    const prefix = stream ? `[${String(stream)}] ` : '';
    return `${prefix}${valueText(directText)}`;
  }

  const chunks: string[] = [];
  if (entry.stdout != null) chunks.push(`[stdout] ${valueText(entry.stdout)}`);
  if (entry.stderr != null) chunks.push(`[stderr] ${valueText(entry.stderr)}`);
  if (chunks.length > 0) return chunks.join('\n');

  return valueText(entry);
}

function idsMatch(a: any, b: any): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function logEntryMatchesStep(entry: any, step: any): boolean {
  if (!entry || typeof entry !== 'object' || !step) return false;
  if (
    idsMatch(entry.deployment_step_id, step.id) ||
    idsMatch(entry.deploymentStepId, step.id) ||
    idsMatch(entry.step_id, step.id) ||
    idsMatch(entry.stepId, step.id)
  ) {
    return true;
  }
  if (
    idsMatch(entry.step_order, step.step_order) ||
    idsMatch(entry.stepOrder, step.step_order) ||
    idsMatch(entry.step_index, step.step_order) ||
    idsMatch(entry.stepIndex, step.step_order)
  ) {
    return true;
  }
  return Boolean(entry.stepName && step.name && String(entry.stepName) === String(step.name));
}

export function deploymentStepLogText(step: any, deploymentLogs: any[] = []): string {
  const entries: any[] = [];
  for (const key of ['log', 'logs', 'output', 'outputs']) {
    if (step?.[key] != null) entries.push(step[key]);
  }
  if (step?.stdout != null) entries.push({ stream: 'stdout', text: step.stdout });
  if (step?.stderr != null) entries.push({ stream: 'stderr', text: step.stderr });
  for (const entry of deploymentLogs || []) {
    if (logEntryMatchesStep(entry, step)) entries.push(entry);
  }
  return entries.map(formatDeploymentLogEntry).filter(Boolean).join('\n').trim();
}

export function releaseItemStatusLabel(item: any): string {
  return item?.inclusion_status === 'excluded' ? 'Excluded' : 'Included';
}

export function releaseItemCardLabel(item: any): string {
  const shortId = item?.card?.shortId ?? item?.card_short_id ?? null;
  const title = item?.card?.title ?? item?.card_title ?? item?.card_id ?? 'Card';
  return shortId ? `#${shortId} ${title}` : String(title);
}

export function releaseItemSupportLabel(item: any): string {
  const ticket = item?.supportTicket;
  const id = ticket?.id ?? item?.support_ticket_id ?? null;
  if (!id) return 'No support ticket';
  const subject = ticket?.subject ?? item?.support_ticket_subject ?? '';
  return subject ? `${subject} (${id})` : `Support ticket ${id}`;
}

export function releaseNotificationRecipientLabel(notification: any): string {
  if (notification?.recipient_type === 'reporter') return 'Reporter';
  if (notification?.recipient_type === 'release_digest') return 'Release digest';
  return String(notification?.recipient_type || notification?.notification_type || 'Recipient');
}

export function releaseNotificationStatusLabel(notification: any): string {
  return String(notification?.status || 'pending').replaceAll('_', ' ');
}
