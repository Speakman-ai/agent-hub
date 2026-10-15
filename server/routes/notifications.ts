/**
 * REST surface for the bell inbox (`/api/notifications`).
 *
 * Every route is scoped to `req.authUserId` with no admin override: another
 * user's row id returns 404 so existence doesn't leak. Reads broadcast
 * `notification_read` stamped with `ownerUserId`; the broadcast filter
 * delivers it only to that user's clients, so a bell open on another device
 * clears the same rows and badge.
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import {
  countUnreadNotifications,
  getNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../notifications-store.js';
import type { RouteDeps } from '../types.js';
import { ListNotificationsQuerySchema } from './notifications.openapi.js';

function requireUser(req: Request, res: Response): string | null {
  const userId = (req as AuthenticatedRequest).authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return userId;
}

export default function createNotificationsRoutes(deps: Pick<RouteDeps, 'broadcast'>): Router {
  const { broadcast } = deps;
  const router = Router();

  function emitRead(
    userId: string,
    payload: { ids: string[]; readAt: string } | { all: true; readAt: string },
  ): void {
    broadcast({
      type: 'notification_read',
      ownerUserId: userId,
      ...payload,
      unreadCount: countUnreadNotifications(userId),
    });
  }

  router.get('/api/notifications', (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const parsed = ListNotificationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' });
      return;
    }
    const { limit, cursor, unread } = parsed.data;
    res.json(listNotifications(userId, { limit, cursor, unreadOnly: unread ?? false }));
  });

  router.get('/api/notifications/unread-count', (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json({ count: countUnreadNotifications(userId) });
  });

  router.post('/api/notifications/read-all', (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const now = new Date();
    const updated = markAllNotificationsRead(userId, now);
    if (updated > 0) emitRead(userId, { all: true, readAt: now.toISOString() });
    res.json({ updated, unreadCount: countUnreadNotifications(userId), readAt: now.toISOString() });
  });

  router.post('/api/notifications/:id/read', (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const id = String(req.params.id);
    const now = new Date();
    const flipped = markNotificationRead(userId, id, now);
    const notification = getNotification(userId, id);
    if (!notification) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    if (flipped) emitRead(userId, { ids: [id], readAt: notification.readAt ?? now.toISOString() });
    res.json({ notification, unreadCount: countUnreadNotifications(userId) });
  });

  return router;
}
