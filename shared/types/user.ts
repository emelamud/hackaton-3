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
