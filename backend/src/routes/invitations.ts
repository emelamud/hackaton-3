import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateParams } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as invitationsService from '../services/invitations.service';
import { getIo } from '../socket/io';
import type { InvitationRevokedPayload } from '../types/shared';

const idSchema = z.object({
  id: z.string().uuid(),
});

const createInvitationSchema = z.object({
  username: z.string().trim().min(1),
});

// Router mounted at /api/invitations — invitee-facing list/accept/reject + inviter-facing revoke.
export const invitationsRouter = Router();

invitationsRouter.use(requireAuth);

invitationsRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await invitationsService.listInvitationsForUser(req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

invitationsRouter.post(
  '/:id/accept',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { room } = await invitationsService.acceptInvitation(
        req.user!.id,
        req.params.id,
      );
      // Subscription sync happens BEFORE broadcast so the accepter's own tabs
      // are in `room:<id>` in time to receive the `room:updated` event below.
      getIo().in(`user:${req.user!.id}`).socketsJoin(`room:${room.id}`);
      getIo().in(`room:${room.id}`).emit('room:updated', room);
      res.status(200).json(room);
    } catch (err) {
      next(err);
    }
  },
);

invitationsRouter.post(
  '/:id/reject',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await invitationsService.rejectInvitation(req.user!.id, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

invitationsRouter.delete(
  '/:id',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const inv = await invitationsService.revokeInvitation(req.user!.id, req.params.id);
      const payload: InvitationRevokedPayload = {
        invitationId: inv.id,
        roomId: inv.roomId,
      };
      getIo().in(`user:${inv.invitedUserId}`).emit('invitation:revoked', payload);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// Router mounted at /api/rooms/:id/invitations — inviter-facing create.
// `mergeParams: true` makes `req.params.id` survive from the parent mount.
export const roomInvitationsRouter = Router({ mergeParams: true });

roomInvitationsRouter.use(requireAuth);

roomInvitationsRouter.post(
  '/',
  validateParams(idSchema),
  validate(createInvitationSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const inv = await invitationsService.createInvitation(
        req.user!.id,
        req.params.id,
        req.body,
      );
      getIo().in(`user:${inv.invitedUserId}`).emit('invitation:new', inv);
      res.status(201).json(inv);
    } catch (err) {
      next(err);
    }
  },
);
