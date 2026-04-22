import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import * as unreadService from '../services/unread.service';

// Round 12 — spans all rooms the caller belongs to, so it lives outside
// `/api/rooms/:id/*`. Mounted as `/api/unread` from `src/index.ts`.
export const unreadRouter = Router();

unreadRouter.use(requireAuth);

unreadRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await unreadService.listUnread(req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
