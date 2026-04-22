export interface UnreadCount {
  roomId: string;
  /** COUNT(messages.created_at > cursor.last_read_at AND user_id <> caller). */
  unreadCount: number;
  /** null when no cursor row exists yet (effective cursor falls back to member.joined_at server-side). */
  lastReadAt: string | null;
}

export interface MarkRoomReadResponse {
  roomId: string;
  /** The timestamp the server actually stored — equal to server now() after the UPSERT. */
  lastReadAt: string;
}

/** Payload for `room:read` socket event. */
export interface RoomReadPayload {
  roomId: string;
  lastReadAt: string;
}
