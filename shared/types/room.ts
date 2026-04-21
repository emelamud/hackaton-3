export type RoomType = 'channel' | 'dm';

export type RoomVisibility = 'public' | 'private';

export type RoomRole = 'owner' | 'admin' | 'member';

export interface DmPeer {
  userId: string;
  username: string;
}

export interface Room {
  id: string;
  type: RoomType;
  name: string | null;
  description: string | null;
  visibility: RoomVisibility;
  ownerId: string | null;
  createdAt: string;
  memberCount: number;
  dmPeer?: DmPeer;
}

export interface RoomMember {
  roomId: string;
  userId: string;
  username: string;
  role: RoomRole;
  joinedAt: string;
}

export type RoomDetail = Room & {
  members: RoomMember[];
};

export interface CreateRoomRequest {
  name: string;
  description?: string;
  visibility: RoomVisibility;
}

export interface PatchRoomRequest {
  name?: string;
  description?: string | null;
  visibility?: RoomVisibility;
}

export interface OpenDmRequest {
  toUserId: string;
}
