import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import type { RouteDeps, Stmts } from '../types.js';

const ALLOWED_TRIGGER = new Set(['manual']);
const ALLOWED_ON_FAILURE = new Set(['abort', 'continue', 'retry']);

/** Thrown for bad request input; transaction handlers map this to HTTP 400. */
class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

type StepInput = {
  id?: string;
  agentId?: string;
  agent_id?: string;
  title?: string;
  rolePrompt?: string;
  role_prompt?: string;
  stepOrder?: number;
  step_order?: number;
  timeoutMs?: number | null;
  timeout_ms?: number | null;
  onFailure?: string;
  on_failure?: string;
  conditionExpr?: string | null;
  condition_expr?: string | null;
  parallelGroup?: number | null;
  parallel_group?: number | null;
};

function jsonStringifyPayload(p: unknown, field: string): string {
  if (p === undefined || p === null) return '{}';
  if (typeof p === 'string') {
    try {
      JSON.parse(p);
    } catch {
      throw new WorkflowValidationError(`${field} must be valid JSON`);
    }
    return p;
  }
  if (typeof p === 'object') {
    return JSON.stringify(p);
  }
  throw new WorkflowValidationError(`${field} must be a JSON object or string`);
}

function tryParseJson(str: string | null | undefined): unknown {
  if (str == null || str === '') return {};
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function requireTriggerType(raw: unknown, fallback: string): string {
  const v = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  if (!ALLOWED_TRIGGER.has(v)) {
    throw new WorkflowValidationError('triggerType must be "manual" in this API version');
  }
  return v;
}

function readStep(
  input: StepInput,
  index: number,
): {
  id: string;
  agentId: string;
  title: string;
  rolePrompt: string;
  stepOrder: number;
  timeoutMs: number | null;
  onFailure: string;
  conditionExpr: string | null;
  parallelGroup: number | null;
} {
  const agentId = (input.agentId ?? input.agent_id) as string | undefined;
  const title = (input.title ?? '') as string;
  const rolePrompt = (input.rolePrompt ?? input.role_prompt ?? '') as string;
  if (!agentId) throw new WorkflowValidationError('each step requires agentId');
  if (!title.trim()) throw new WorkflowValidationError('each step requires a non-empty title');
  if (!String(rolePrompt).length)
    throw new WorkflowValidationError('each step requires rolePrompt');

  const ofRaw = (input.onFailure ?? input.on_failure) || 'abort';
  if (typeof ofRaw !== 'string' || !ALLOWED_ON_FAILURE.has(ofRaw)) {
    throw new WorkflowValidationError('onFailure must be "abort", "continue", or "retry"');
  }
  const stepOrder = input.stepOrder ?? input.step_order;
  const order = typeof stepOrder === 'number' && Number.isFinite(stepOrder) ? stepOrder : index;
  const timeoutRaw = input.timeoutMs ?? input.timeout_ms;
  const timeout =
    timeoutRaw == null
      ? null
      : typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
        ? Math.floor(timeoutRaw)
        : (() => {
            throw new WorkflowValidationError('timeoutMs must be a number or null');
          })();
  const cond = input.conditionExpr ?? input.condition_expr;
  const conditionExpr = cond == null || cond === '' ? null : String(cond);
  const pgRaw = input.parallelGroup ?? input.parallel_group;
  const parallelGroup =
    pgRaw == null
      ? null
      : typeof pgRaw === 'number' && Number.isFinite(pgRaw)
        ? Math.floor(pgRaw)
        : (() => {
            throw new WorkflowValidationError('parallelGroup must be a number or null');
          })();
  return {
    id: typeof input.id === 'string' && input.id ? input.id : uuidv4(),
    agentId,
    title: title.trim(),
    rolePrompt: String(rolePrompt),
    stepOrder: order,
    timeoutMs: timeout,
    onFailure: ofRaw,
    conditionExpr,
    parallelGroup,
  };
}

function assertAgentInProject(
  findAgent: RouteDeps['findAgent'],
  projectId: string,
  agentId: string,
) {
  const found = findAgent(agentId);
  if (!found || found.project.id !== projectId) {
    throw new WorkflowValidationError('agent not found in this project');
  }
}

function loadWorkflowForProject(stmts: Stmts, projectId: string, workflowId: string) {
  const w = stmts.getWorkflow.get(workflowId) as
    | (Record<string, unknown> & { project_id: string })
    | undefined;
  if (!w || w.project_id !== projectId) return null;
  return w;
}

function toWorkflowResponse(
  row: Record<string, unknown> & { project_id?: string },
  steps: Record<string, unknown>[],
) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    trigger_type: row.trigger_type,
    default_payload: tryParseJson((row.default_payload as string) ?? '{}'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    steps: steps.map(toStepResponse),
  };
}

function toStepResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    agent_id: row.agent_id,
    title: row.title,
    role_prompt: row.role_prompt,
    step_order: row.step_order,
    timeout_ms: row.timeout_ms,
    on_failure: row.on_failure,
    condition_expr: row.condition_expr,
    parallel_group: row.parallel_group,
    created_at: row.created_at,
  };
}

function toRunResponse(row: Record<string, unknown>) {
  const rp = row.run_payload;
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    status: row.status,
    run_payload: rp == null ? null : tryParseJson(rp as string),
    error: row.error,
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

function groupStepsByWorkflowId(
  stepRows: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const m = new Map<string, Record<string, unknown>[]>();
  for (const s of stepRows) {
    const wId = String(s.workflow_id);
    let list = m.get(wId);
    if (!list) {
      list = [];
      m.set(wId, list);
    }
    list.push(s);
  }
  return m;
}

const DEFAULT_RUN_LIST_LIMIT = 100;
const MAX_RUN_LIST_LIMIT = 500;

function parseRunListLimit(req: Request): number {
  const q = req.query['limit'];
  if (q === undefined) return DEFAULT_RUN_LIST_LIMIT;
  const raw = Array.isArray(q) ? q[0] : q;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RUN_LIST_LIMIT;
  return Math.min(n, MAX_RUN_LIST_LIMIT);
}

const DUPLICATE_WORKFLOW_STEP_ID_MSG =
  'duplicate or conflicting workflow step `id` — omit `id` to autogenerate, or use a unique id per step (including across workflows)';

function isWorkflowStepUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // better-sqlite3: "SqliteError: UNIQUE constraint failed: workflow_steps.id"
  return /UNIQUE constraint failed:.*workflow_steps\.id|UNIQUE.*workflow_steps/i.test(e.message);
}

function insertSteps(
  stmts: Stmts,
  findAgent: RouteDeps['findAgent'],
  projectId: string,
  workflowId: string,
  stepInputs: StepInput[],
) {
  const list = stepInputs.length > 0 ? stepInputs : [];
  const resolved: ReturnType<typeof readStep>[] = [];
  for (let i = 0; i < list.length; i++) {
    resolved.push(readStep(list[i] as StepInput, i));
  }
  const seen = new Set<string>();
  for (const s of resolved) {
    if (seen.has(s.id)) {
      throw new WorkflowValidationError('duplicate step `id` in `steps` array');
    }
    seen.add(s.id);
  }
  for (const s of resolved) {
    assertAgentInProject(findAgent, projectId, s.agentId);
    stmts.createWorkflowStep.run(
      s.id,
      workflowId,
      s.agentId,
      s.title,
      s.rolePrompt,
      s.stepOrder,
      s.timeoutMs,
      s.onFailure,
      s.conditionExpr,
      s.parallelGroup,
    );
  }
}

export default function createWorkflowRoutes({
  findProject,
  findAgent,
  stmts,
  broadcast,
}: RouteDeps): Router {
  const router = Router();

  const list = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const rows = stmts.getWorkflowsByProject.all(projectId) as Record<string, unknown>[];
    const stepRows = stmts.getWorkflowStepsByProject.all(projectId) as Record<string, unknown>[];
    const byWorkflow = groupStepsByWorkflowId(stepRows);
    const out = rows.map((row) => {
      const wId = String(row.id);
      return toWorkflowResponse(
        { ...row, project_id: row.project_id } as Record<string, unknown> & { project_id?: string },
        byWorkflow.get(wId) ?? [],
      );
    });
    return res.json(out);
  };

  const post = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const body = req.body as {
      name?: string;
      triggerType?: string;
      trigger_type?: string;
      defaultPayload?: unknown;
      default_payload?: unknown;
      steps?: StepInput[];
    };
    const name = (body.name ?? '') as string;
    if (!name.trim()) return res.status(400).json({ error: 'name is required' });

    let defaultPayload: string;
    let trigger: string;
    try {
      defaultPayload = jsonStringifyPayload(
        body.defaultPayload ?? body.default_payload,
        'defaultPayload',
      );
      const tt = (body.triggerType ?? body.trigger_type) as string | undefined;
      trigger = requireTriggerType(tt, 'manual');
    } catch (e) {
      if (e instanceof WorkflowValidationError) {
        return res.status(400).json({ error: e.message });
      }
      console.error('[workflows] POST /workflows validation', e);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const id = uuidv4();
    const stepList = Array.isArray(body.steps) ? body.steps : [];
    try {
      getDb().transaction(() => {
        stmts.createWorkflow.run(id, projectId, name.trim(), trigger, defaultPayload);
        insertSteps(stmts, findAgent, projectId, id, stepList);
      })();
    } catch (e) {
      if (e instanceof WorkflowValidationError) {
        return res.status(400).json({ error: e.message });
      }
      if (isWorkflowStepUniqueConstraintError(e)) {
        return res.status(400).json({ error: DUPLICATE_WORKFLOW_STEP_ID_MSG });
      }
      console.error('[workflows] POST /workflows transaction', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
    const row = loadWorkflowForProject(stmts, projectId, id)!;
    const stepRows = stmts.getWorkflowSteps.all(id) as Record<string, unknown>[];
    broadcast({ type: 'workflow_update', projectId, workflowId: id, action: 'create' });
    return res.status(201).json(toWorkflowResponse(row, stepRows));
  };

  const getOne = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
    const wf = loadWorkflowForProject(stmts, projectId, req.params.workflowId as string);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const stepRows = stmts.getWorkflowSteps.all(req.params.workflowId) as Record<string, unknown>[];
    return res.json(toWorkflowResponse(wf, stepRows));
  };

  const put = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
    const cur = loadWorkflowForProject(stmts, projectId, req.params.workflowId as string);
    if (!cur) return res.status(404).json({ error: 'Workflow not found' });

    const body = req.body as {
      name?: string;
      triggerType?: string;
      trigger_type?: string;
      defaultPayload?: unknown;
      default_payload?: unknown;
      steps?: StepInput[] | null;
    };

    const nextName =
      body.name != null && typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : (cur.name as string);

    let defaultPayload = cur.default_payload as string;
    let trigger = (cur.trigger_type as string) || 'manual';
    if (body.defaultPayload !== undefined || body.default_payload !== undefined) {
      try {
        defaultPayload = jsonStringifyPayload(
          body.defaultPayload ?? body.default_payload,
          'defaultPayload',
        );
      } catch (e) {
        if (e instanceof WorkflowValidationError) {
          return res.status(400).json({ error: (e as Error).message });
        }
        console.error('[workflows] PUT /workflows defaultPayload', e);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
    if (body.triggerType !== undefined || body.trigger_type !== undefined) {
      try {
        const tt = (body.triggerType ?? body.trigger_type) as string;
        trigger = requireTriggerType(tt, trigger);
      } catch (e) {
        if (e instanceof WorkflowValidationError) {
          return res.status(400).json({ error: (e as Error).message });
        }
        console.error('[workflows] PUT /workflows trigger', e);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    const hasSteps = Object.prototype.hasOwnProperty.call(req.body, 'steps');
    try {
      getDb().transaction(() => {
        stmts.updateWorkflow.run(
          nextName,
          trigger,
          defaultPayload,
          req.params.workflowId,
          projectId,
        );
        if (hasSteps) {
          const stepList = Array.isArray(body.steps) ? (body.steps as StepInput[]) : [];
          stmts.deleteWorkflowStepsByWorkflow.run(req.params.workflowId);
          insertSteps(stmts, findAgent, projectId, req.params.workflowId as string, stepList);
        }
      })();
    } catch (e) {
      if (e instanceof WorkflowValidationError) {
        return res.status(400).json({ error: (e as Error).message });
      }
      if (isWorkflowStepUniqueConstraintError(e)) {
        return res.status(400).json({ error: DUPLICATE_WORKFLOW_STEP_ID_MSG });
      }
      console.error('[workflows] PUT /workflows transaction', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
    const row = loadWorkflowForProject(stmts, projectId, req.params.workflowId as string)!;
    const stepRows = stmts.getWorkflowSteps.all(req.params.workflowId) as Record<string, unknown>[];
    broadcast({ type: 'workflow_update', projectId, workflowId: row.id, action: 'update' });
    return res.json(toWorkflowResponse(row, stepRows));
  };

  const del = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
    const w = loadWorkflowForProject(stmts, projectId, req.params.workflowId as string);
    if (!w) return res.status(404).json({ error: 'Workflow not found' });
    stmts.deleteWorkflow.run(req.params.workflowId, projectId);
    broadcast({
      type: 'workflow_update',
      projectId,
      workflowId: req.params.workflowId,
      action: 'delete',
    });
    return res.json({ ok: true });
  };

  const postRun = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
    if (!loadWorkflowForProject(stmts, projectId, req.params.workflowId as string)) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    const body = req.body as { payload?: unknown; runPayload?: unknown; run_payload?: unknown };
    const raw = body.runPayload ?? body.run_payload ?? body.payload;
    let runPayload: string | null;
    try {
      // Omitted and explicit null both store SQL NULL; objects/strings stringify (use `{}` for an empty run payload)
      if (raw === undefined || raw === null) runPayload = null;
      else runPayload = jsonStringifyPayload(raw, 'runPayload');
    } catch (e) {
      if (e instanceof WorkflowValidationError) {
        return res.status(400).json({ error: (e as Error).message });
      }
      console.error('[workflows] POST run payload', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
    const id = uuidv4();
    stmts.createWorkflowRun.run(id, req.params.workflowId, 'pending', runPayload);
    const run = stmts.getWorkflowRun.get(id) as Record<string, unknown> | undefined;
    broadcast({ type: 'workflow_run', projectId, workflowId: req.params.workflowId, runId: id });
    if (!run) {
      return res.status(201).json({ id, workflow_id: req.params.workflowId, status: 'pending' });
    }
    return res.status(201).json(toRunResponse(run));
  };

  const listRuns = (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
    if (!loadWorkflowForProject(stmts, projectId, req.params.workflowId as string)) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    const limit = parseRunListLimit(req);
    const runs = stmts.getWorkflowRunsLimited.all(req.params.workflowId, limit) as Record<
      string,
      unknown
    >[];
    return res.json(runs.map(toRunResponse));
  };

  router.get('/api/projects/:projectId/workflows', list);
  router.post('/api/projects/:projectId/workflows', post);
  router.get('/api/projects/:projectId/workflows/:workflowId', getOne);
  router.put('/api/projects/:projectId/workflows/:workflowId', put);
  router.delete('/api/projects/:projectId/workflows/:workflowId', del);
  router.get('/api/projects/:projectId/workflows/:workflowId/runs', listRuns);
  router.post('/api/projects/:projectId/workflows/:workflowId/runs', postRun);

  return router;
}
