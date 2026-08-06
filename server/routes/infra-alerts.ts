/**
 * Infra alert-rule and alert-lifecycle routes.
 *
 *   GET    /api/projects/:projectId/infra/alert-rules
 *   POST   /api/projects/:projectId/infra/alert-rules
 *   PUT    /api/projects/:projectId/infra/alert-rules/:ruleId
 *   DELETE /api/projects/:projectId/infra/alert-rules/:ruleId
 *   GET    /api/projects/:projectId/infra/alerts
 *   GET    /api/projects/:projectId/infra/alerts/:alertId
 *   PUT    /api/projects/:projectId/infra/alerts/:alertId/status
 *
 * The operator surface for decision INFRA-ALERT. None of these routes touch
 * AWS: rules are evaluated by our own poller, so creating one writes a SQLite
 * row and nothing else — no `PutMetricAlarm`, no SNS topic, and nothing left
 * behind in the monitored account when the rule is deleted.
 *
 * Admin-gated, matching `routes/infra.ts` and the AWS profile routes. Alert
 * bodies themselves carry resource identifiers only (the hard constraint from
 * INFRA-NOTIFY), but a rule's scope selector names accounts and regions, and
 * splitting the module's gate would leave the same operator able to read the
 * alert but not the rule that fired it.
 *
 * Store availability is handled the way `routes/infra.ts` handles it, and for
 * the same reason — `initInfraDb()` failures are logged and swallowed at boot,
 * so these handlers can legitimately run with no store behind them:
 *
 *   - reads degrade to an empty body, so the Alerts tab renders its "nothing
 *     yet" state rather than an error that reads like a monitoring fault;
 *   - writes return 503, because silently accepting a rule that was never
 *     persisted is the worse failure.
 */
import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';
import { isInfraDbInitialized } from '../infra/infra-db.js';
import {
  createInfraAlertRule,
  deleteInfraAlertRule,
  getInfraAlert,
  listInfraAlertRules,
  listInfraAlerts,
  listInfraAlertTransitions,
  serializeInfraAlert,
  serializeInfraAlertRule,
  setInfraAlertStatus,
  updateInfraAlertRule,
  InfraAlertRuleValidationError,
  type InfraAlertRuleInput,
  type InfraAlertRulePatch,
} from '../infra/alert-store.js';
import {
  AlertRuleCreateSchema,
  AlertRuleUpdateSchema,
  AlertRuleListParamsSchema,
  AlertListParamsSchema,
  AlertStatusRequestSchema,
} from './infra-alerts.openapi.js';

/** Same 400 envelope `routes/infra.ts` emits, so the module answers uniformly. */
function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): { ok: true; data: z.infer<T> } | { ok: false } {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

function actorId(req: Request): string | null {
  return (req as AuthenticatedRequest).authUserId ?? null;
}

export default function createInfraAlertRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  /**
   * Project 404 and store availability, in the order every handler needs them.
   *
   * 404-before-503 is deliberate and asserted in tests: a request naming a
   * project that does not exist is malformed whether or not the store is open,
   * and answering 503 first would tell an unauthorized caller that the project
   * they guessed at is real.
   */
  function gate(req: Request, res: Response, opts: { write: boolean }): boolean {
    if (!findProject(req.params.projectId as string)) {
      res.status(404).json({ error: 'Project not found' });
      return false;
    }
    if (opts.write && !isInfraDbInitialized()) {
      res.status(503).json({ error: 'Infrastructure store is unavailable' });
      return false;
    }
    return true;
  }

  // ── Rules ────────────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:projectId/infra/alert-rules',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!gate(req, res, { write: false })) return;
      const parsed = validate(AlertRuleListParamsSchema, req.query ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.json({ rules: [] });
        return;
      }
      const rules = listInfraAlertRules({
        projectId: req.params.projectId as string,
        service: parsed.data.service,
        enabled: parsed.data.enabled === undefined ? undefined : parsed.data.enabled === 'true',
      });
      res.json({ rules: rules.map(serializeInfraAlertRule) });
    },
  );

  router.post(
    '/api/projects/:projectId/infra/alert-rules',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!gate(req, res, { write: true })) return;
      const parsed = validate(AlertRuleCreateSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      try {
        const rule = createInfraAlertRule(
          req.params.projectId as string,
          parsed.data as InfraAlertRuleInput,
          Date.now(),
        );
        res.status(201).json(serializeInfraAlertRule(rule));
      } catch (err) {
        if (err instanceof InfraAlertRuleValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.put(
    '/api/projects/:projectId/infra/alert-rules/:ruleId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!gate(req, res, { write: true })) return;
      const parsed = validate(AlertRuleUpdateSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      try {
        const rule = updateInfraAlertRule(
          req.params.projectId as string,
          req.params.ruleId as string,
          parsed.data as InfraAlertRulePatch,
          Date.now(),
        );
        if (!rule) {
          res.status(404).json({ error: 'Alert rule not found' });
          return;
        }
        res.json(serializeInfraAlertRule(rule));
      } catch (err) {
        if (err instanceof InfraAlertRuleValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/infra/alert-rules/:ruleId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!gate(req, res, { write: true })) return;
      const deleted = deleteInfraAlertRule(
        req.params.projectId as string,
        req.params.ruleId as string,
      );
      if (!deleted) {
        res.status(404).json({ error: 'Alert rule not found' });
        return;
      }
      res.status(204).end();
    },
  );

  // ── Alerts ───────────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:projectId/infra/alerts',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!gate(req, res, { write: false })) return;
      const parsed = validate(AlertListParamsSchema, req.query ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.json({ alerts: [], nextCursor: null });
        return;
      }
      const page = listInfraAlerts({
        projectId: req.params.projectId as string,
        ...parsed.data,
      });
      res.json({
        alerts: page.alerts.map((alert) => serializeInfraAlert(alert)),
        nextCursor: page.nextCursor,
      });
    },
  );

  router.get(
    '/api/projects/:projectId/infra/alerts/:alertId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      // A detail read needs the store open to answer at all — an empty body
      // here would be indistinguishable from "this alert does not exist".
      if (!gate(req, res, { write: true })) return;
      const alert = getInfraAlert(req.params.projectId as string, req.params.alertId as string);
      if (!alert) {
        res.status(404).json({ error: 'Alert not found' });
        return;
      }
      res.json(serializeInfraAlert(alert, listInfraAlertTransitions(alert.id)));
    },
  );

  router.put(
    '/api/projects/:projectId/infra/alerts/:alertId/status',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!gate(req, res, { write: true })) return;
      const parsed = validate(AlertStatusRequestSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      const updated = setInfraAlertStatus(
        req.params.projectId as string,
        req.params.alertId as string,
        parsed.data.status,
        actorId(req),
        Date.now(),
      );
      if (!updated) {
        res.status(404).json({ error: 'Alert not found' });
        return;
      }
      res.json(serializeInfraAlert(updated, listInfraAlertTransitions(updated.id)));
    },
  );

  return router;
}
