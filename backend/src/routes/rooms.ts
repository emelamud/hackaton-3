import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateParams, validateQuery } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as roomsService from '../services/rooms.service';
import * as messagesService from '../services/messages.service';
import { emitToRoom, getIo } from '../socket/io';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

const createRoomSchema = z.object({
  name: z.string().trim().min(3).max(64),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['public', 'private']),
});

// Empty-body detection is intentionally deferred to the service layer so the
// 400 response carries the contract-exact `"At least one field is required"`
// message rather than the generic `"Validation failed" + details` envelope
// produced by the zod `validate` middleware.
const patchRoomSchema = z.object({
  name: z.string().trim().min(3).max(64).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
});

const idSchema = z.object({
  id: z.string().uuid(),
});

// Round 9 — cursor-paginated message history. `limit` default = 50, clamped
// to [1, 100]; `before` is an optional message UUID that must exist in the
// same room (checked in the service layer for the `Invalid cursor` 400).
const messageHistoryQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
  validateQuery(messageHistoryQuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const params = req.query as unknown as z.infer<
        typeof messageHistoryQuerySchema
      >;
      const result = await messagesService.listMessageHistory(
        req.user!.id,
        req.params.id,
        params,
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

// PATCH /api/rooms/:id
roomsRouter.patch(
  '/:id',
  validateParams(idSchema),
  validate(patchRoomSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const detail = await roomsService.patchRoom(req.user!.id, req.params.id, req.body);
      emitToRoom(detail.id, 'room:updated', detail);
      res.status(200).json(detail);
    } catch (err) {
      next(err);
    }
  },
);
