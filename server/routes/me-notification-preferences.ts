/**
 * GET/PUT /api/me/notification-preferences — the caller's per-category,
 * per-channel notification matrix. Scoped to `req.authUserId`; there is no way
 * to read or write another user's prefs.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SECTIONS,
} from '../../shared/utils/notificationCategories.js';
import {
  getUserNotificationPrefs,
  updateUserNotificationPrefs,
  type NotificationCategoryPrefs,
  type NotificationPrefsPatch,
} from '../notification-prefs-store.js';
import type { RouteDeps } from '../types.js';
import { UpdateNotificationPreferencesRequestSchema } from './me-notification-preferences.openapi.js';

function serialize(prefs: NotificationCategoryPrefs[]) {
  const meta = new Map(NOTIFICATION_CATEGORIES.map((c) => [c.id, c]));
  return {
    channels: [...NOTIFICATION_CHANNELS],
    sections: NOTIFICATION_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      categories: s.categories.map((c) => c.id),
    })),
    categories: prefs.map((p) => {
      const c = meta.get(p.category);
      return {
        category: p.category,
        section: c?.section ?? '',
        label: c?.label ?? p.category,
        description: c?.description ?? '',
        in_app: p.in_app,
        desktop: p.desktop,
        push: p.push,
        defaults: c ? { ...c.defaults } : { in_app: false, desktop: false, push: false },
        isDefault: p.isDefault,
      };
    }),
  };
}

export default function createMeNotificationPreferencesRoutes(_deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/me/notification-preferences', (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    res.json(serialize(getUserNotificationPrefs(userId)));
  });

  router.put('/api/me/notification-preferences', (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = UpdateNotificationPreferencesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return res.status(400).json({ error: `${where}${issue?.message ?? 'Invalid body'}` });
    }
    const prefs = updateUserNotificationPrefs(
      userId,
      parsed.data.categories as NotificationPrefsPatch,
    );
    res.json(serialize(prefs));
  });

  return router;
}
