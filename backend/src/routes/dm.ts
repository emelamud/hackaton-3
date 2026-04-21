import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as dmService from '../services/dm.service';
import * as roomsService from '../services/rooms.service';
import { emitToUser, getIo } from '../socket/io';

const openDmSchema = z.object({
  toUserId: z.string().uuid(),
});

export const dmRouter = Router();

dmRouter.use(requireAuth);

dmRouter.post(
  '/',
  validate(openDmSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerUserId = req.user!.id;
      const targetUserId = req.body.toUserId as string;

      const { room, created } = await dmService.openDirectMessage(
        callerUserId,
        targetUserId,
      );

      if (created) {
        // Subscribe both users' existing sockets to `room:<id>` BEFORE
        // broadcasting so the first `message:new` lands correctly — same
        // pattern as `POST /api/invitations/:id/accept`.
        getIo().in(`user:${callerUserId}`).socketsJoin(`room:${room.id}`);
        getIo().in(`user:${targetUserId}`).socketsJoin(`room:${room.id}`);

        // Each recipient's `RoomDetail.dmPeer` must name the OTHER user. The
        // service already returned the caller's view; re-derive the target's
        // view by asking `roomsService.getRoomDetail` from the target's POV.
        const callerView = room;
        const targetView = await roomsService.getRoomDetail(targetUserId, room.id);
        emitToUser(callerUserId, 'dm:created', callerView);
        emitToUser(targetUserId, 'dm:created', targetView);
      }

      res.status(created ? 201 : 200).json(room);
    } catch (err) {
      next(err);
    }
  },
);
