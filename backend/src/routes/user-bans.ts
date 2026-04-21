import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateParams } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as userBansService from '../services/user-bans.service';
import { emitToUser } from '../socket/io';

const createUserBanSchema = z.object({
  userId: z.string().uuid(),
});

const userIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

export const userBansRouter = Router();

userBansRouter.use(requireAuth);

userBansRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await userBansService.listBans(req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

userBansRouter.post(
  '/',
  validate(createUserBanSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerUserId = req.user!.id;
      const targetUserId = req.body.userId as string;

      const { severedFriendship } = await userBansService.banUser(
        callerUserId,
        targetUserId,
      );
      emitToUser(targetUserId, 'user:ban:applied', { userId: callerUserId });
      // Companion emission so Round 5's FriendsService drops the row live.
      // The two events are independent — `user:ban:applied` freezes the DM;
      // `friend:removed` updates the friends list.
      if (severedFriendship) {
        emitToUser(targetUserId, 'friend:removed', { userId: callerUserId });
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

userBansRouter.delete(
  '/:userId',
  validateParams(userIdParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerUserId = req.user!.id;
      const targetUserId = req.params.userId;

      await userBansService.unbanUser(callerUserId, targetUserId);
      emitToUser(targetUserId, 'user:ban:removed', { userId: callerUserId });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
