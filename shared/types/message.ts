export interface Message {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  body: string;
  createdAt: string;
}

export interface SendMessagePayload {
  roomId: string;
  body: string;
}

export type MessageSendAck =
  | { ok: true; message: Message }
  | { ok: false; error: string };
