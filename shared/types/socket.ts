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
import type { PresenceUpdatePayload, PresenceSnapshotPayload } from './presence';

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
  'presence:update': PresenceUpdatePayload;
  'presence:snapshot': PresenceSnapshotPayload;
}

export type ServerToClientEvent = keyof ServerToClientEvents;

// Round 7 introduces typed client → server events. Scoped to presence only
// for this round; `message:send` retains its ad-hoc SendMessagePayload / ack
// callback signature from Round 3 and is deliberately NOT listed here —
// migrating it is a low-value typing churn deferred to a future pass.
export interface ClientToServerEvents {
  'presence:active': () => void;
  'presence:idle': () => void;
}

export type ClientToServerEvent = keyof ClientToServerEvents;
