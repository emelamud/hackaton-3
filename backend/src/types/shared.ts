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
