export type PresenceState = 'online' | 'afk' | 'offline';

export interface UserPresence {
  userId: string;
  state: PresenceState;
}

export interface PresenceUpdatePayload {
  userId: string;
  state: PresenceState;
}

export interface PresenceSnapshotPayload {
  presences: UserPresence[];
}
