export interface Friend {
  userId: string;
  username: string;
  friendshipCreatedAt: string;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  fromUsername: string;
  toUserId: string;
  toUsername: string;
  message: string | null;
  createdAt: string;
}

export interface CreateFriendRequestBody {
  toUsername: string;
  message?: string;
}

export interface FriendRequestCancelledPayload {
  requestId: string;
}

export interface FriendRequestAcceptedPayload {
  requestId: string;
  friend: Friend;
}

export interface FriendRequestRejectedPayload {
  requestId: string;
}

export interface FriendRemovedPayload {
  userId: string;
}

export type UserSearchRelationship =
  | 'self'
  | 'friend'
  | 'outgoing_pending'
  | 'incoming_pending'
  | 'none';

export interface UserSearchResult {
  id: string;
  username: string;
  relationship: UserSearchRelationship;
}
