import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { validateParams } from '../middleware/validate';
import { AppError } from '../errors/AppError';
import { db } from '../db';
import { rooms, roomMembers } from '../db/schema';
import * as attachmentsService from '../services/attachments.service';
import * as userBansService from '../services/user-bans.service';
import { config } from '../config';

export const attachmentsRouter = Router();

// Multer: memoryStorage because we own the real on-disk layout inside the
// service (keeps multer's tempdir off the public file namespace). Single
// field, 10-field cap to block request smuggling via absurd body sizes.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB global cap
    files: 1,
    fields: 10,
  },
});

const uploadBodySchema = z.object({
  roomId: z.string().uuid(),
  comment: z
    .string()
    .max(200, 'Comment is at most 200 characters')
    .optional(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Percent-encode a filename for `Content-Disposition: filename*=UTF-8''…`
 * per RFC 5987. `encodeURIComponent` leaves a few characters (`!'()*`) that
 * older browsers' parsers choke on — this extra step brings the result to
 * the strict attr-char subset: `A-Za-z0-9-._~!$&'()*+,;=:@`.
 */
function encodeRFC5987ValueChars(str: string): string {
  return encodeURIComponent(str)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%(7C|60|5E)/g, (_, hex) => '%' + hex);
}

/**
 * Magic-byte sniff — rejects a file whose declared image MIME does not match
 * the first few bytes on disk. The whitelist is narrow (PNG / JPEG / GIF /
 * WebP) so the signature table is short; arbitrary-type uploads skip the
 * sniff because there's no reliable prefix for an unbounded set.
 *
 * Returns `true` on match, `false` on mismatch. Assumes `buffer.length > 0`.
 */
function imageMagicMatches(mimeType: string, buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  switch (mimeType) {
    case 'image/png':
      // 89 50 4E 47 0D 0A 1A 0A
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );
    case 'image/jpeg':
      // FF D8 FF
      return (
        buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      );
    case 'image/gif':
      // "GIF8"  → 47 49 46 38 (covers both GIF87a and GIF89a)
      return (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38
      );
    case 'image/webp':
      // RIFF....WEBP → "RIFF" at 0, "WEBP" at 8
      if (buffer.length < 12) return false;
      return (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      );
    default:
      return false;
  }
}

// POST /api/attachments — multipart upload.
//
// Two-layer middleware: `requireAuth` (401 bail) → multer parse. We wrap
// multer in a closure so its own errors land on `next(err)` with the right
// status code (413 for LIMIT_FILE_SIZE), consistent with the contract-
// documented error order.
attachmentsRouter.post(
  '/',
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        // Multer's own error — we map LIMIT_FILE_SIZE explicitly because its
        // default message leaks implementation detail, and map the rest to
        // generic 400 so we don't leak internals either.
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            next(new AppError('File exceeds size limit', 413));
            return;
          }
          next(new AppError('Invalid upload', 400));
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerId = req.user!.id;
      const file = req.file;

      // Order below matches the contract spec:
      //   413 (multer) already handled above
      //   1. Missing file
      //   2. Body validation
      //   3. Room lookup / membership / DM-ban
      //   4. Unsupported type (empty Content-Type)
      //   5. Image-size sub-cap (3 MB)
      //   6. Magic-byte sniff
      //   7. Success
      if (!file) {
        throw new AppError('File is required', 400);
      }

      const parsed = uploadBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));
        throw new AppError('Validation failed', 400, details);
      }

      const roomId = parsed.data.roomId;
      const commentRaw = parsed.data.comment ?? '';
      const commentTrimmed = commentRaw.trim();
      const comment = commentTrimmed.length > 0 ? commentTrimmed : null;

      // Room existence — 404 before any membership answer so we don't confuse
      // "room doesn't exist" with "not a member".
      const [room] = await db
        .select({ id: rooms.id, type: rooms.type })
        .from(rooms)
        .where(eq(rooms.id, roomId))
        .limit(1);
      if (!room) {
        throw new AppError('Room not found', 404);
      }

      const [membership] = await db
        .select({ userId: roomMembers.userId })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, callerId),
          ),
        )
        .limit(1);
      if (!membership) {
        throw new AppError('Forbidden', 403);
      }

      // DM-ban gate — mirrors `messages.service.persistMessage`: only fires
      // for DM rooms; channels never consult user_bans.
      if (room.type === 'dm') {
        const [peer] = await db
          .select({ userId: roomMembers.userId })
          .from(roomMembers)
          .where(
            and(eq(roomMembers.roomId, roomId), ne(roomMembers.userId, callerId)),
          )
          .limit(1);
        if (peer && (await userBansService.hasBanBetween(callerId, peer.userId))) {
          throw new AppError('Personal messaging is blocked', 403);
        }
      }

      const mimeType = (file.mimetype ?? '').toLowerCase().trim();
      if (mimeType.length === 0) {
        throw new AppError('Unsupported file type', 400);
      }

      // Image sub-cap — 3 MB. Use the derived kind (MIME + whitelist) so a
      // claimed-image file that's off-whitelist falls through as `file`.
      const kind = attachmentsService.deriveKind(mimeType);
      if (kind === 'image' && file.size > 3 * 1024 * 1024) {
        throw new AppError('File exceeds size limit', 413);
      }

      // Magic-byte sniff — only for whitelisted image MIMEs; `kind='file'`
      // skips this step (can't sniff an unbounded set).
      if (kind === 'image' && !imageMagicMatches(mimeType, file.buffer)) {
        throw new AppError('File content does not match declared type', 400);
      }

      // Original filename may be absent (multer makes no guarantee); fall back
      // to a stable placeholder so the DTO's `filename` is always a string.
      const originalName = file.originalname && file.originalname.length > 0
        ? file.originalname
        : 'upload';

      const attachment = await attachmentsService.createPendingAttachment({
        uploaderId: callerId,
        roomId,
        filename: originalName,
        mimeType,
        sizeBytes: file.size,
        comment,
        buffer: file.buffer,
      });

      res.status(201).json({ attachment });
    } catch (err) {
      next(err);
    }
  },
);

// Test-only endpoint — registers in non-production builds so the smoke harness
// can force-invoke the orphan sweep with a short TTL. Gated on NODE_ENV so the
// route simply is not mounted in prod.
if (config.nodeEnv !== 'production') {
  attachmentsRouter.post(
    '/__sweep-for-tests',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const maxAgeMs =
          typeof req.body?.maxAgeMs === 'number' ? req.body.maxAgeMs : 0;
        const result = await attachmentsService.sweepPendingAttachments(
          Date.now(),
          maxAgeMs,
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );
}

// GET /api/attachments/:id — authenticated stream.
attachmentsRouter.get(
  '/:id',
  requireAuth,
  validateParams(idParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerId = req.user!.id;
      const { attachment, absolutePath } =
        await attachmentsService.getAttachmentForDownload(req.params.id, callerId);

      const dispositionKind = attachment.kind === 'image' ? 'inline' : 'attachment';
      const encodedName = encodeRFC5987ValueChars(attachment.filename);

      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Content-Length', String(attachment.sizeBytes));
      res.setHeader(
        'Content-Disposition',
        `${dispositionKind}; filename*=UTF-8''${encodedName}`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

      const stream = fs.createReadStream(absolutePath);
      stream.on('error', (err) => {
        // Race with orphan sweep / manual cleanup — if we haven't flushed the
        // response yet fall back to a clean 500; otherwise just end the
        // connection (the client sees a truncated body).
        if (!res.headersSent) {
          // eslint-disable-next-line no-console
          console.error('attachment stream error', err);
          res.status(500).json({ error: 'Internal server error' });
          return;
        }
        res.destroy(err as Error);
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  },
);
