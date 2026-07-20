// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { buildCardActions, cardCopyPayload } from './kanbanCardActions';
const columns = [
    { id: 'todo', name: 'To Do', color: '#1' },
    { id: 'doing', name: 'In Progress', color: '#2' },
    { id: 'done', name: 'Done', color: '#3' },
];
const epics = [
    { id: 'e1', name: 'Billing', color: '#a' },
    { id: 'e2', name: 'Auth', color: '#b' },
];
const agents = [
    { id: 'a1', name: 'Dev' },
    { id: 'a2', name: 'Docs' },
];
const labels = ['bug', 'ui'];
const baseCtx = { columns, epics, agents, labels };
function group(actions: any, key: any) {
    return actions.find((a: any) => a.key === key);
}
describe('buildCardActions', () => {
    it('returns the canonical top-level groups in order', () => {
        const actions = buildCardActions({ id: 'c1' }, baseCtx);
        expect(actions.map((a: any) => a.key)).toEqual([
            'status',
            'priority',
            'assignee',
            'labels',
            'epic',
            'copy',
            'delete',
        ]);
    });
    it('marks delete as a danger leaf with a delete action', () => {
        const del = group(buildCardActions({ id: 'c1' }, baseCtx), 'delete');
        expect(del.leaf).toBe(true);
        expect(del.danger).toBe(true);
        expect(del.action).toEqual({ type: 'delete' });
    });
    it('checks the current column in the status submenu', () => {
        const status = group(buildCardActions({ id: 'c1', column_id: 'doing' }, baseCtx), 'status');
        const checked = status.options.filter((o: any) => o.checked);
        expect(checked).toHaveLength(1);
        expect(checked[0].action).toEqual({ type: 'move', columnId: 'doing' });
    });
    it('checks the current priority (defaulting to medium)', () => {
        const pri = group(buildCardActions({ id: 'c1' }, baseCtx), 'priority');
        expect(pri.options.find((o: any) => o.checked).action).toEqual({
            type: 'setPriority',
            priority: 'medium',
        });
        const high = group(buildCardActions({ id: 'c1', priority: 'high' }, baseCtx), 'priority');
        expect(high.options.find((o: any) => o.checked).action).toEqual({
            type: 'setPriority',
            priority: 'high',
        });
    });
    it('lists agents and checks the current assignee, with no Unassign when unassigned', () => {
        const assignee = group(buildCardActions({ id: 'c1' }, baseCtx), 'assignee');
        expect(assignee.options.map((o: any) => o.label)).toEqual(['Dev', 'Docs']);
        expect(assignee.options.some((o: any) => o.action?.type === 'unassign')).toBe(false);
    });
    it('adds an Unassign option when the card has an assignee or session', () => {
        const assigned = group(buildCardActions({ id: 'c1', assignee: 'Dev' }, baseCtx), 'assignee');
        const checked = assigned.options.find((o: any) => o.checked);
        expect(checked.action).toEqual({ type: 'assign', agentId: 'a1', name: 'Dev' });
        expect(assigned.options.at(-1).action).toEqual({ type: 'unassign' });
        const sessioned = group(buildCardActions({ id: 'c1', session_id: 's1' }, baseCtx), 'assignee');
        expect(sessioned.options.at(-1).action).toEqual({ type: 'unassign' });
    });
    it('shows a disabled placeholder when there are no agents', () => {
        const assignee = group(buildCardActions({ id: 'c1' }, { ...baseCtx, agents: [] }), 'assignee');
        expect(assignee.options).toHaveLength(1);
        expect(assignee.options[0].disabled).toBe(true);
    });
    it('marks active labels as checked and keepOpen, toggling via action', () => {
        const lbl = group(buildCardActions({ id: 'c1', labels: 'bug' }, baseCtx), 'labels');
        const bug = lbl.options.find((o: any) => o.label === 'bug');
        const ui = lbl.options.find((o: any) => o.label === 'ui');
        expect(bug.checked).toBe(true);
        expect(bug.keepOpen).toBe(true);
        expect(bug.action).toEqual({ type: 'toggleLabel', label: 'bug' });
        expect(ui.checked).toBe(false);
    });
    it('shows a disabled placeholder when there are no labels', () => {
        const lbl = group(buildCardActions({ id: 'c1' }, { ...baseCtx, labels: [] }), 'labels');
        expect(lbl.options).toHaveLength(1);
        expect(lbl.options[0].disabled).toBe(true);
    });
    it('offers "No epic" plus each epic, checking the linked one', () => {
        const epic = group(buildCardActions({ id: 'c1', epic_id: 'e2' }, baseCtx), 'epic');
        expect(epic.options[0].action).toEqual({ type: 'linkEpic', epicId: null });
        const checked = epic.options.find((o: any) => o.checked);
        expect(checked.action).toEqual({ type: 'linkEpic', epicId: 'e2' });
    });
    it('checks "No epic" when the card has no epic', () => {
        const epic = group(buildCardActions({ id: 'c1' }, baseCtx), 'epic');
        expect(epic.options[0].checked).toBe(true);
    });
    it('exposes copy id / copy link leaves', () => {
        const copy = group(buildCardActions({ id: 'c1' }, baseCtx), 'copy');
        expect(copy.options.map((o: any) => o.action.type)).toEqual(['copyId', 'copyLink']);
    });
    it('copies the rendered short ID and canonical card link', () => {
        const card = { id: 'uuid-1', short_id: 42 };
        expect(cardCopyPayload(card, 'copyId', { board: { card_prefix: 'AH' } })).toBe('AH-42');
        expect(cardCopyPayload(card, 'copyLink', {
            baseUrl: 'https://hub.example.com/',
            projectId: 'agent-hub',
        })).toBe('https://hub.example.com/projects/agent-hub/board?card=uuid-1');
    });
    it('falls back to the card ID when a shareable link cannot be built', () => {
        expect(cardCopyPayload({ id: 'legacy-card' }, 'copyId')).toBe('legacy-card');
        expect(cardCopyPayload({ id: 'legacy-card' }, 'copyLink', { projectId: 'agent-hub' })).toBe('legacy-card');
    });
    it('tolerates missing context', () => {
        const actions = buildCardActions({ id: 'c1' });
        expect(actions.map((a: any) => a.key)).toContain('status');
        expect(group(actions, 'status').options).toEqual([]);
    });
});
