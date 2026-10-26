import type { QaPlanListItemWire } from './api';

/**
 * How a linked QA plan reads from an epic or card. `failing` and `running`
 * only apply before sign-off: a Done plan's latest run is all-pass by
 * definition, so it is never failing.
 */
export type QaLinkTone = 'failing' | 'running' | 'in_progress' | 'new' | 'done';

export function qaPlanTone(plan: QaPlanListItemWire): QaLinkTone {
  if (plan.status === 'done') return 'done';
  const run = plan.summary.latestRun;
  if (run) {
    if (run.status === 'queued' || run.status === 'running') return 'running';
    if (run.status === 'failed' || run.verdicts.fail + run.verdicts.needs_change > 0) {
      return 'failing';
    }
  }
  return plan.status === 'in_progress' ? 'in_progress' : 'new';
}

export const QA_TONE_LABELS: Record<QaLinkTone, string> = {
  failing: 'Failing',
  running: 'Running',
  in_progress: 'In progress',
  new: 'New',
  done: 'Done',
};

export const QA_TONE_CLASS: Record<QaLinkTone, string> = {
  failing: 'border-red-800 bg-red-900/40 text-red-300',
  running: 'border-blue-800 bg-blue-900/40 text-blue-300',
  in_progress: 'border-amber-800 bg-amber-900/40 text-amber-300',
  new: 'border-gray-700 bg-gray-800 text-gray-400',
  done: 'border-emerald-800 bg-emerald-900/40 text-emerald-300',
};

export interface QaPlansByLink {
  byCard: Map<string, QaPlanListItemWire[]>;
  byEpic: Map<string, QaPlanListItemWire[]>;
}

/** Group a project's plans by the card and epic each one links to. */
export function indexQaPlansByLink(plans: QaPlanListItemWire[]): QaPlansByLink {
  const byCard = new Map<string, QaPlanListItemWire[]>();
  const byEpic = new Map<string, QaPlanListItemWire[]>();
  const push = (map: Map<string, QaPlanListItemWire[]>, key: string, p: QaPlanListItemWire) => {
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  };
  for (const p of plans) {
    if (p.cardId) push(byCard, p.cardId, p);
    if (p.epicId) push(byEpic, p.epicId, p);
  }
  return { byCard, byEpic };
}

export interface QaBoardIndicator {
  tone: Extract<QaLinkTone, 'failing' | 'running' | 'in_progress'>;
  /** Plans that are active (in progress or failing). */
  count: number;
  title: string;
}

const ACTIVE_RANK = { failing: 3, running: 2, in_progress: 1 } as const;

/**
 * Board tiles only flag plans that need attention: in progress (including a
 * queued or running pass) or failing. New and Done plans stay quiet. The
 * tile shows the most severe tone across the card's plans.
 */
export function qaBoardIndicator(plans: QaPlanListItemWire[] | undefined): QaBoardIndicator | null {
  if (!plans || plans.length === 0) return null;
  let tone: QaBoardIndicator['tone'] | null = null;
  const lines: string[] = [];
  for (const p of plans) {
    const t = qaPlanTone(p);
    if (t !== 'failing' && t !== 'running' && t !== 'in_progress') continue;
    lines.push(`${p.title}: ${QA_TONE_LABELS[t].toLowerCase()}`);
    if (!tone || ACTIVE_RANK[t] > ACTIVE_RANK[tone]) tone = t;
  }
  if (!tone) return null;
  return { tone, count: lines.length, title: `QA ${lines.join(' · ')}` };
}
