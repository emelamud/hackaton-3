import type { Attachment } from './attachment';

export interface Message {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  body: string;
  createdAt: string;
  attachments?: Attachment[];
}

export interface SendMessagePayload {
  roomId: string;
  body: string;
  attachmentIds?: string[];
}

export type MessageSendAck =
  | { ok: true; message: Message }
  | { ok: false; error: string };
