import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateParams } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as messagesService from '../services/messages.service';
import { emitToRoom } from '../socket/io';

// Round 10 — PATCH + DELETE `/api/messages/:id`.
// Edit/delete are author-only in Round 10; room-admin delete is Round 11.
// Both routes broadcast to ALL sockets in `room:<roomId>` INCLUDING the
// author's own tab (divergent from `message:send`'s sender-exclusion
// pattern — the HTTP mutation path has no socket handle).
export const messagesRouter = Router();

messagesRouter.use(requireAuth);

const idSchema = z.object({
  id: z.string().uuid(),
});

const editMessageSchema = z.object({
  // No length constraint at the zod layer — trim + 1..3072 validation
  // happens inside the service so the contract-exact "Body must be between
  // 1 and 3072 characters" string is produced (matching `message:send`).
  body: z.string(),
});

// PATCH /api/messages/:id
messagesRouter.patch(
  '/:id',
  validateParams(idSchema),
  validate(editMessageSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const updated = await messagesService.editMessage(
        req.user!.id,
        req.params.id,
        req.body.body,
      );
      // Blanket room fan-out — includes the author's own socket(s) so other
      // tabs of the same user reconcile. The mutating tab re-renders from
      // the HTTP response; the broadcast is a no-op for it.
      emitToRoom(updated.roomId, 'message:edit', updated);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/messages/:id
messagesRouter.delete(
  '/:id',
  validateParams(idSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { roomId } = await messagesService.deleteMessage(
        req.user!.id,
        req.params.id,
      );
      emitToRoom(roomId, 'message:delete', { roomId, messageId: req.params.id });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
