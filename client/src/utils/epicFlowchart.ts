/**
 * Build a Mermaid flowchart for Epic → Phase → Ticket hierarchy with blocker edges.
 */

function safeId(raw: string, prefix: string): string {
  const base = raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) || 'x';
  return `${prefix}_${base}`;
}

function columnDone(name: string): boolean {
  return name.toLowerCase() === 'done';
}

export function buildEpicFlowchartMermaid(args: {
  epic: { id: string; name: string; color?: string };
  phases: Array<{ id: string; name: string; autonomous?: number }>;
  cards: Array<{
    id: string;
    title: string;
    phase_id?: string | null;
    epic_id?: string | null;
    column_id: string;
    blockers?: Array<{ id: string; title: string; done?: boolean }>;
  }>;
  columnNameById: Record<string, string>;
}): string {
  const { epic, phases, cards, columnNameById } = args;
  const epicCards = cards.filter((c) => c.epic_id === epic.id);
  const lines: string[] = ['flowchart TD'];

  const epicNode = safeId(epic.id, 'epic');
  lines.push(`  ${epicNode}["${escapeLabel(epic.name)}"]`);
  lines.push(
    `  classDef epicNode fill:${epic.color || '#6366F1'}22,stroke:${epic.color || '#6366F1'},color:#e5e7eb`,
  );

  const sortedPhases = [...phases].sort((a, b) => a.name.localeCompare(b.name));
  const unphased = epicCards.filter((c) => !c.phase_id);

  for (const phase of sortedPhases) {
    const phaseNode = safeId(phase.id, 'phase');
    const autoBadge = phase.autonomous ? ' ⚡' : '';
    lines.push(`  subgraph ${phaseNode}_sg ["${escapeLabel(phase.name)}${autoBadge}"]`);
    lines.push(`    direction TB`);
    const phaseCards = epicCards.filter((c) => c.phase_id === phase.id);
    for (const card of phaseCards) {
      const cardNode = safeId(card.id, 'card');
      const col = columnNameById[card.column_id] || '';
      const done = columnDone(col);
      const style = done ? 'doneTicket' : 'openTicket';
      lines.push(`    ${cardNode}["${escapeLabel(card.title)}"]`);
      lines.push(`    class ${cardNode} ${style}`);
    }
    lines.push(`  end`);
    lines.push(`  ${epicNode} --> ${phaseNode}_sg`);
  }

  if (unphased.length > 0) {
    lines.push(`  subgraph unphased_sg ["Unassigned"]`);
    lines.push(`    direction TB`);
    for (const card of unphased) {
      const cardNode = safeId(card.id, 'card');
      const col = columnNameById[card.column_id] || '';
      const done = columnDone(col);
      const style = done ? 'doneTicket' : 'openTicket';
      lines.push(`    ${cardNode}["${escapeLabel(card.title)}"]`);
      lines.push(`    class ${cardNode} ${style}`);
    }
    lines.push(`  end`);
    lines.push(`  ${epicNode} --> unphased_sg`);
  }

  // Blocker edges (only within this epic's cards)
  const epicCardIds = new Set(epicCards.map((c) => c.id));
  for (const card of epicCards) {
    const from = safeId(card.id, 'card');
    for (const blocker of card.blockers || []) {
      if (!epicCardIds.has(blocker.id)) continue;
      const to = safeId(blocker.id, 'card');
      lines.push(`  ${to} --> ${from}`);
    }
  }

  lines.push(`  class ${epicNode} epicNode`);
  lines.push(`  classDef openTicket fill:#1e293b,stroke:#64748b,color:#e2e8f0`);
  lines.push(`  classDef doneTicket fill:#064e3b,stroke:#10b981,color:#d1fae5`);

  return lines.join('\n');
}

function escapeLabel(text: string): string {
  return String(text || '')
    .replace(/"/g, "'")
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .slice(0, 80);
}
