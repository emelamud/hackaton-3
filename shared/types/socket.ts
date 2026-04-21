import type { Message } from './message';
import type { RoomDetail } from './room';
import type { Invitation, InvitationRevokedPayload } from './invitation';
import type {
  FriendRequest,
  FriendRequestAcceptedPayload,
  FriendRequestCancelledPayload,
  FriendRequestRejectedPayload,
  FriendRemovedPayload,
} from './friend';
import type { UserBanAppliedPayload, UserBanRemovedPayload } from './user-ban';

export interface ServerToClientEvents {
  'message:new': Message;
  'room:updated': RoomDetail;
  'invitation:new': Invitation;
  'invitation:revoked': InvitationRevokedPayload;
  'friend:request:new': FriendRequest;
  'friend:request:cancelled': FriendRequestCancelledPayload;
  'friend:request:accepted': FriendRequestAcceptedPayload;
  'friend:request:rejected': FriendRequestRejectedPayload;
  'friend:removed': FriendRemovedPayload;
  'dm:created': RoomDetail;
  'user:ban:applied': UserBanAppliedPayload;
  'user:ban:removed': UserBanRemovedPayload;
}

export type ServerToClientEvent = keyof ServerToClientEvents;
