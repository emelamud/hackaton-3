import type { Attachment } from './attachment';

export interface ReplyPreview {
  id: string;
  userId: string;
  username: string;
  // First 140 chars of the target body, server-side raw slice. No ellipsis
  // suffix on the wire — FE owns any visual truncation affordance.
  bodyPreview: string;
  createdAt: string;
}

export interface Message {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  body: string;
  createdAt: string;
  // Round 10 — always present on the wire. `null` for unedited messages,
  // ISO string for edited ones.
  editedAt: string | null;
  attachments?: Attachment[];
  // Round 10 — OMITTED when the message is not a reply; PRESENT AS `null`
  // when the message was a reply but the original target has been deleted
  // (messages.reply_to_id FK uses ON DELETE SET NULL). FE is free to treat
  // `null` identically to "field absent" — the distinction preserves a
  // "was a reply" signal for a later polish round.
  replyTo?: ReplyPreview | null;
}

export interface SendMessagePayload {
  roomId: string;
  body: string;
  attachmentIds?: string[];
  // Round 10 — when present, must reference an existing message in the same
  // `roomId`. Cross-room or unknown id fails the send with ack error
  // `'Invalid reply target'`.
  replyToId?: string;
}

export type MessageSendAck =
  | { ok: true; message: Message }
  | { ok: false; error: string };

export interface MessageHistoryResponse {
  messages: Message[];
  hasMore: boolean;
}

// Round 10 — PATCH /api/messages/:id body.
export interface EditMessageRequest {
  // Trimmed length 1-3072 chars. Trim-to-empty permitted ONLY when the
  // message has ≥1 attached attachment (attachment-only messages can have
  // their body cleared).
  body: string;
}

// Round 10 — payload for the `message:delete` server-to-client event.
export interface MessageDeletedPayload {
  roomId: string;
  messageId: string;
}
