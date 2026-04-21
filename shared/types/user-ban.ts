export interface UserBan {
  userId: string;
  username: string;
  createdAt: string;
}

export interface CreateUserBanRequest {
  userId: string;
}

export interface UserBanAppliedPayload {
  userId: string;
}

export interface UserBanRemovedPayload {
  userId: string;
}
