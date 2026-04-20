/**
 * Local mirror of /shared/types — kept in sync manually.
 * Do not modify the originals in /shared/types.
 */

export interface User {
  id: string;
  email: string;
  username: string;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
}

export interface Session {
  id: string;
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent?: boolean;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  keepSignedIn?: boolean;
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

export interface RefreshResponse {
  accessToken: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

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
