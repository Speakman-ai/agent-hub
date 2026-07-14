/**
 * Kanban card action-sheet model (mobile).
 *
 * The mobile equivalent of the web `CardContextMenu`: a long-press opens an
 * action sheet whose top-level rows mirror the web menu (Status, Priority,
 * Assignee, Labels, Epic, Copy, Delete). Each row either carries `options`
 * (a second sheet of choices) or is a `leaf` that fires immediately.
 *
 * `buildCardActions` is pure — it maps a card + board metadata into a
 * serialisable model. Each option carries an `action` descriptor
 * (`{ type, ... }`) that the screen's single dispatcher executes, so the
 * mapping (what's offered, what's checked, which leaves exist) is
 * unit-testable without rendering anything.
 */
import { PRIORITIES, priorityMeta, cardLabelList } from './kanbanCard';
const cap = (s: any) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
/**
 * @param {object} card - the long-pressed card row.
 * @param {object} ctx
 * @param {Array}  ctx.columns - board columns ({ id, name }).
 * @param {Array}  ctx.epics   - epics ({ id, name, color }).
 * @param {Array}  ctx.agents  - assignable agents ({ id, name }).
 * @param {Array}  ctx.labels  - distinct label strings across the board.
 * @returns {Array} top-level action rows.
 */
export function buildCardActions(card: any, { columns = [], epics = [], agents = [], labels = [] }: any = {}) {
    const cardLabels = new Set(cardLabelList(card?.labels));
    const assigneeOptions = agents.map((a: any) => ({
        key: `agent-${a.id}`,
        label: a.name,
        checked: card?.assignee === a.name,
        action: { type: 'assign', agentId: a.id, name: a.name },
    }));
    if (card?.assignee || card?.session_id) {
        assigneeOptions.push({
            key: '__unassign',
            label: 'Unassign',
            action: { type: 'unassign' },
        });
    }
    const labelOptions = labels.length
        ? labels.map((l: any) => ({
            key: `label-${l}`,
            label: l,
            checked: cardLabels.has(l),
            keepOpen: true,
            action: { type: 'toggleLabel', label: l },
        }))
        : [{ key: '__nolabels', label: 'No labels yet', disabled: true }];
    return [
        {
            key: 'status',
            label: 'Status',
            title: 'Move to column',
            options: columns.map((col: any) => ({
                key: `col-${col.id}`,
                label: col.name,
                color: col.color,
                checked: col.id === card?.column_id,
                action: { type: 'move', columnId: col.id },
            })),
        },
        {
            key: 'priority',
            label: 'Priority',
            title: 'Set priority',
            options: PRIORITIES.map((p: any) => ({
                key: `pri-${p}`,
                label: cap(p),
                color: priorityMeta(p).color,
                checked: (card?.priority || 'medium') === p,
                action: { type: 'setPriority', priority: p },
            })),
        },
        {
            key: 'assignee',
            label: 'Assignee',
            title: 'Assign agent',
            options: assigneeOptions.length
                ? assigneeOptions
                : [{ key: '__noagents', label: 'No agents', disabled: true }],
        },
        {
            key: 'labels',
            label: 'Labels',
            title: 'Toggle labels',
            options: labelOptions,
        },
        {
            key: 'epic',
            label: 'Epic',
            title: 'Link to epic',
            options: [
                {
                    key: '__noepic',
                    label: 'No epic',
                    checked: !card?.epic_id,
                    action: { type: 'linkEpic', epicId: null },
                },
                ...epics.map((e: any) => ({
                    key: `epic-${e.id}`,
                    label: e.name,
                    color: e.color,
                    checked: card?.epic_id === e.id,
                    action: { type: 'linkEpic', epicId: e.id },
                })),
            ],
        },
        {
            key: 'copy',
            label: 'Copy',
            title: 'Copy',
            options: [
                { key: 'copy-id', label: 'Copy ID', action: { type: 'copyId' } },
                { key: 'copy-link', label: 'Copy link', action: { type: 'copyLink' } },
            ],
        },
        {
            key: 'delete',
            label: 'Delete',
            danger: true,
            leaf: true,
            action: { type: 'delete' },
        },
    ];
}
