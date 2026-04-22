import { and, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import {
  attachments,
  roomMembers,
  type NewAttachmentRow,
} from '../db/schema';
import * as schema from '../db/schema';
import { AppError } from '../errors/AppError';
import { config } from '../config';
import type { Attachment, AttachmentKind } from '@shared';

// Drizzle's `tx` param is a `PgTransaction` — not assignable to
// `NodePgDatabase`. Accept the union so callers pass either the top-level
// `db` or a live tx.
type Schema = typeof schema;
type DbOrTx =
  | NodePgDatabase<Schema>
  | PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const ORPHAN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Server-side kind derivation. A MIME that starts with `image/` AND is on the
 * inline-image whitelist maps to `image`; anything else is an arbitrary file.
 */
export function deriveKind(mimeType: string): AttachmentKind {
  return ALLOWED_IMAGE_MIMES.has(mimeType) ? 'image' : 'file';
}

export function isAllowedImageMime(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIMES.has(mimeType);
}

/**
 * Shape a DB row into the wire `Attachment` DTO — drops internal fields
 * (`status`, `messageId`, `storagePath`, `attachedAt`) that FE clients have
 * no need for per the shared contract.
 *
 * Exported (Round 9) so the message-history batch-hydrator in
 * `messages.service.ts` can reuse the exact same field mapping used by
 * `createPendingAttachment` and `commitAttachmentsToMessage` — keeps wire
 * parity with `message:send` ack / `message:new` for free.
 */
export function toAttachmentDto(row: {
  id: string;
  roomId: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  comment: string | null;
  createdAt: Date;
}): Attachment {
  return {
    id: row.id,
    roomId: row.roomId,
    uploaderId: row.uploaderId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    kind: row.kind as AttachmentKind,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve the on-disk path for a given attachment id. Layout is
 * `<UPLOADS_DIR>/<yyyy>/<mm>/<attachmentId>` — the creation date picks the
 * subdir; we store the resolved string back in `storage_path` so download
 * lookups don't depend on the row's `createdAt`.
 */
function buildStoragePath(attachmentId: string, createdAt: Date): string {
  const yyyy = String(createdAt.getUTCFullYear());
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return path.join(config.uploadsDir, yyyy, mm, attachmentId);
}

/**
 * Persist a freshly-uploaded blob: write the bytes to disk under the
 * date-sharded layout, insert the DB row with `status='pending'`, and return
 * the wire DTO. If the DB insert throws, the half-written file is removed on
 * a best-effort basis so the filesystem doesn't collect orphans.
 */
export async function createPendingAttachment(args: {
  uploaderId: string;
  roomId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  comment: string | null;
  buffer: Buffer;
}): Promise<Attachment> {
  const kind = deriveKind(args.mimeType);
  const now = new Date();
  const [inserted] = await db
    .insert(attachments)
    .values({
      roomId: args.roomId,
      uploaderId: args.uploaderId,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      kind,
      comment: args.comment,
      // Resolved after we know the generated id — we update below.
      storagePath: '',
      status: 'pending',
      createdAt: now,
    } satisfies NewAttachmentRow)
    .returning();

  const storagePath = buildStoragePath(inserted.id, inserted.createdAt);
  try {
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.promises.writeFile(storagePath, args.buffer);
    await db
      .update(attachments)
      .set({ storagePath })
      .where(eq(attachments.id, inserted.id));
  } catch (err) {
    // Best-effort cleanup so a partial write doesn't turn into a forever-pending
    // row with an unresolved path.
    await fs.promises
      .unlink(storagePath)
      .catch(() => {
        // Swallow — file may not exist yet. We still need to drop the row.
      });
    await db
      .delete(attachments)
      .where(eq(attachments.id, inserted.id))
      .catch(() => {
        /* swallow secondary failure; the orphan sweep will retry. */
      });
    throw err;
  }

  return toAttachmentDto(inserted);
}

/**
 * Load an attachment by id and enforce that the caller is a current member of
 * `attachment.roomId`. Returns the wire DTO plus the resolved absolute file
 * path for the download route to stream. Error messages are constants — never
 * leak a disk path or stored filename in the 403 / 404 body.
 */
export async function getAttachmentForDownload(
  attachmentId: string,
  callerId: string,
): Promise<{ attachment: Attachment; absolutePath: string }> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);

  if (!row) {
    throw new AppError('Attachment not found', 404);
  }

  const [membership] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, row.roomId),
        eq(roomMembers.userId, callerId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new AppError('Forbidden', 403);
  }

  return {
    attachment: toAttachmentDto(row),
    absolutePath: row.storagePath,
  };
}

/**
 * Inside the caller-provided transaction, flip a set of pending attachments
 * to `attached` and wire them to the new message. Validates each id has the
 * expected `uploader_id`, `room_id`, and `status='pending'` before mutating —
 * any mismatch short-circuits into a single `Invalid attachment reference`
 * AppError. The ack contract intentionally collapses all failure sub-cases
 * into that single string (FE can't usefully distinguish them).
 *
 * NOTE: a `message:send` with `attachmentIds: []` never reaches this helper.
 * Callers must skip the call for zero-length arrays.
 */
export async function commitAttachmentsToMessage(args: {
  attachmentIds: string[];
  callerId: string;
  roomId: string;
  messageId: string;
  tx: DbOrTx;
}): Promise<Attachment[]> {
  const { attachmentIds, callerId, roomId, messageId, tx } = args;

  // Hard cap echoed from the contract (D2 = 5). A 6+ id request fails fast.
  if (attachmentIds.length === 0 || attachmentIds.length > 5) {
    throw new AppError('Invalid attachment reference', 400);
  }

  // Guard against duplicate ids in the payload — flipping the same row twice
  // would silently succeed and the caller could reference the same upload N
  // times. Cheap set-based check covers it.
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new AppError('Invalid attachment reference', 400);
  }

  const results: Attachment[] = [];
  for (const id of attachmentIds) {
    const [row] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, id))
      .limit(1);

    if (!row) {
      throw new AppError('Invalid attachment reference', 400);
    }
    if (
      row.uploaderId !== callerId ||
      row.roomId !== roomId ||
      row.status !== 'pending'
    ) {
      throw new AppError('Invalid attachment reference', 400);
    }

    const now = new Date();
    const [updated] = await tx
      .update(attachments)
      .set({ status: 'attached', messageId, attachedAt: now })
      .where(
        and(
          eq(attachments.id, id),
          // Belt-and-suspenders — re-assert the precondition at UPDATE time
          // so a concurrent commit loses the race cleanly rather than
          // silently reattaching.
          eq(attachments.status, 'pending'),
        ),
      )
      .returning();

    if (!updated) {
      throw new AppError('Invalid attachment reference', 400);
    }

    results.push(toAttachmentDto(updated));
  }

  return results;
}

/**
 * Delete orphaned `pending` attachments older than the configured TTL — both
 * the DB row and the on-disk file. Individual file-unlink errors are logged
 * and swallowed so a missing file doesn't block row cleanup (the row is the
 * canonical reference; a stray file without a row is just disk waste that
 * the next sweep won't see).
 */
export async function sweepPendingAttachments(
  nowMs: number = Date.now(),
  maxAgeMs: number = ORPHAN_TTL_MS,
): Promise<{ deletedCount: number }> {
  const cutoff = new Date(nowMs - maxAgeMs);

  const rows = await db
    .select({ id: attachments.id, storagePath: attachments.storagePath })
    .from(attachments)
    .where(
      and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoff)),
    );

  let deletedCount = 0;
  for (const row of rows) {
    try {
      await db.delete(attachments).where(eq(attachments.id, row.id));
      deletedCount++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`sweep: failed to delete row ${row.id}`, err);
      continue;
    }
    if (row.storagePath) {
      await fs.promises.unlink(row.storagePath).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`sweep: failed to unlink ${row.storagePath}`, err);
      });
    }
  }

  return { deletedCount };
}
