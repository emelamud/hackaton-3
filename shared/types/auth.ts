import type { User } from './user';

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
