import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as authService from '../services/auth.service';
import { config } from '../config';

export const authRouter = Router();

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function setRefreshCookie(res: Response, token: string, persistent: boolean): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production',
    ...(persistent ? { maxAge: REFRESH_MAX_AGE_MS } : {}),
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production',
  });
}

// POST /api/auth/register
const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(32),
  password: z.string().min(8),
});

authRouter.post(
  '/register',
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.register(req.body, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });
      setRefreshCookie(res, result.refreshToken, true);
      res.status(201).json({ accessToken: result.accessToken, user: result.user });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/login
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  keepSignedIn: z.boolean().optional(),
});

authRouter.post(
  '/login',
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.login(req.body, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });
      const persistent = req.body.keepSignedIn === true;
      setRefreshCookie(res, result.refreshToken, persistent);
      res.status(200).json({ accessToken: result.accessToken, user: result.user });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/logout
authRouter.post(
  '/logout',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sessionId = req.user!.sessionId;
      await authService.logout(sessionId);
      clearRefreshCookie(res);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/refresh
authRouter.post(
  '/refresh',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const refreshToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
      if (!refreshToken) {
        clearRefreshCookie(res);
        res.status(401).json({ error: 'Missing refresh token' });
        return;
      }

      const result = await authService.refresh(refreshToken, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });

      // Re-set cookie maintaining same maxAge behaviour — use 30d persistent
      setRefreshCookie(res, result.refreshToken, true);
      res.status(200).json({ accessToken: result.accessToken });
    } catch (err) {
      clearRefreshCookie(res);
      next(err);
    }
  },
);

// POST /api/auth/forgot-password
const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

authRouter.post(
  '/forgot-password',
  validate(forgotPasswordSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await authService.forgotPassword(req.body.email);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/reset-password
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

authRouter.post(
  '/reset-password',
  validate(resetPasswordSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await authService.resetPassword(req.body.token, req.body.password);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);
