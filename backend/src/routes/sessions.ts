import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import * as authService from '../services/auth.service';

export const sessionsRouter = Router();

// GET /api/auth/sessions
sessionsRouter.get(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const currentSessionId = req.user!.sessionId;
      const userSessions = await authService.getSessions(req.user!.id);

      const result = userSessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        isCurrent: s.id === currentSessionId,
      }));

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/auth/sessions/:id
sessionsRouter.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await authService.deleteSession(req.params.id, req.user!.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
