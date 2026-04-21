import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateParams } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as friendsService from '../services/friends.service';
import * as usersService from '../services/users.service';
import { emitToUser } from '../socket/io';
import { AppError } from '../errors/AppError';

const idSchema = z.object({
  id: z.string().uuid(),
});

const userIdSchema = z.object({
  userId: z.string().uuid(),
});

const createFriendRequestSchema = z.object({
  toUsername: z.string().trim().min(1).max(64),
  message: z.string().trim().max(500).optional(),
});

// Query schema is intentionally limited to the max-length bound so long
// queries are rejected via the standard zod envelope. The min-length check
// lives in `usersService.searchUsers` to surface the exact contract string
// `"Search query must be at least 2 characters"`.
const userSearchQuerySchema = z.object({
  q: z.string().max(64),
});

// Router mounted at /api/friends — list + remove.
export const friendshipsRouter = Router();

friendshipsRouter.use(requireAuth);

friendshipsRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await friendsService.listFriends(req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

friendshipsRouter.delete(
  '/:userId',
  validateParams(userIdSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const otherUserId = req.params.userId;
      await friendsService.removeFriend(req.user!.id, otherUserId);
      emitToUser(otherUserId, 'friend:removed', { userId: req.user!.id });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// Router mounted at /api/friend-requests — CRUD + accept/reject.
export const friendRequestsRouter = Router();

friendRequestsRouter.use(requireAuth);

friendRequestsRouter.get(
  '/incoming',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await friendsService.listIncomingFriendRequests(
        req.user!.id,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

friendRequestsRouter.get(
  '/outgoing',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await friendsService.listOutgoingFriendRequests(
        req.user!.id,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

friendRequestsRouter.post(
  '/',
  validate(createFriendRequestSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const request = await friendsService.createFriendRequest(
        req.user!.id,
        req.body,
      );
      emitToUser(request.toUserId, 'friend:request:new', request);
      res.status(201).json(request);
    } catch (err) {
      next(err);
    }
  },
);

friendRequestsRouter.post(
  '/:id/accept',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { request, friendForRecipient, friendForSender } =
        await friendsService.acceptFriendRequest(req.user!.id, req.params.id);

      // Fan out to BOTH sides — each receives the opposite party in `friend`.
      emitToUser(request.fromUserId, 'friend:request:accepted', {
        requestId: request.id,
        friend: friendForSender,
      });
      emitToUser(request.toUserId, 'friend:request:accepted', {
        requestId: request.id,
        friend: friendForRecipient,
      });

      res.status(200).json(friendForRecipient);
    } catch (err) {
      next(err);
    }
  },
);

friendRequestsRouter.post(
  '/:id/reject',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const request = await friendsService.rejectFriendRequest(
        req.user!.id,
        req.params.id,
      );
      emitToUser(request.fromUserId, 'friend:request:rejected', {
        requestId: request.id,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

friendRequestsRouter.delete(
  '/:id',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const request = await friendsService.cancelFriendRequest(
        req.user!.id,
        req.params.id,
      );
      emitToUser(request.toUserId, 'friend:request:cancelled', {
        requestId: request.id,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// Router mounted at /api/users — search endpoint. Separate file is overkill
// for a single endpoint; lives here alongside friends since the two domains
// are tightly coupled (search relationship derives from friends/requests).
export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get(
  '/search',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Zod-validate only the max-length bound; the min-length error string
      // must match the contract verbatim and is raised in the service.
      const rawQ = typeof req.query.q === 'string' ? req.query.q : '';
      const parsed = userSearchQuerySchema.safeParse({ q: rawQ });
      if (!parsed.success) {
        const details = parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));
        next(new AppError('Validation failed', 400, details));
        return;
      }
      const result = await usersService.searchUsers(req.user!.id, parsed.data.q);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
