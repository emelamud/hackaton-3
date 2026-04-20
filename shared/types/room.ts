export type RoomVisibility = 'public' | 'private';

export type RoomRole = 'owner' | 'admin' | 'member';

export interface Room {
  id: string;
  name: string;
  description: string | null;
  visibility: RoomVisibility;
  ownerId: string;
  createdAt: string;
  memberCount: number;
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
