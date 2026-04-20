import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateParams } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as roomsService from '../services/rooms.service';
import * as messagesService from '../services/messages.service';
import { getIo } from '../socket/io';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

const createRoomSchema = z.object({
  name: z.string().trim().min(3).max(64),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['public', 'private']),
});

const idSchema = z.object({
  id: z.string().uuid(),
});

// GET /api/rooms
roomsRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await roomsService.listRoomsForUser(req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/rooms
roomsRouter.post(
  '/',
  validate(createRoomSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await roomsService.createRoom(req.user!.id, req.body);
      // Nudge all of this user's live sockets into the new room's channel
      // so they receive `message:new` without reconnecting.
      getIo().in(`user:${req.user!.id}`).socketsJoin(`room:${result.id}`);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/rooms/:id
roomsRouter.get(
  '/:id',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await roomsService.getRoomDetail(req.user!.id, req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/rooms/:id/messages
roomsRouter.get(
  '/:id/messages',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await messagesService.listRecentMessages(
        req.user!.id,
        req.params.id,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/rooms/:id/join
roomsRouter.post(
  '/:id/join',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await roomsService.joinRoom(req.user!.id, req.params.id);
      getIo().in(`user:${req.user!.id}`).socketsJoin(`room:${result.id}`);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/rooms/:id/leave
roomsRouter.post(
  '/:id/leave',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await roomsService.leaveRoom(req.user!.id, req.params.id);
      getIo().in(`user:${req.user!.id}`).socketsLeave(`room:${req.params.id}`);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
