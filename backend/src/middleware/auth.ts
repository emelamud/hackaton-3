import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../errors/AppError';

export interface AuthPayload {
  id: string;
  email: string;
  username: string;
  sessionId: string;
}

// Augment Express Request type via @types/express module augmentation
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Shared JWT-verify step used by both HTTP `requireAuth` and Socket.io `io.use()`.
 * Throws the underlying `jsonwebtoken` error on failure — callers wrap into their
 * transport-specific error shape (AppError for HTTP, Error('Unauthorized') for WS).
 */
export function verifyAccessToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwtSecret) as AuthPayload;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError('Missing or invalid authorization header', 401));
    return;
  }

  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new AppError('Invalid or expired access token', 401));
  }
}
