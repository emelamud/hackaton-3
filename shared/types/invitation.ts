export interface Invitation {
  id: string;
  roomId: string;
  roomName: string;
  invitedUserId: string;
  invitedByUserId: string;
  invitedByUsername: string;
  createdAt: string;
}

export interface CreateInvitationRequest {
  username: string;
}

export interface InvitationRevokedPayload {
  invitationId: string;
  roomId: string;
}
