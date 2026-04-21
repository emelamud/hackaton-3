import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, sessions } from '../db/schema';
import { config } from '../config';
import { AppError } from '../errors/AppError';
import type {
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  RefreshResponse,
} from '../types/shared';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface IssueTokensOptions {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

async function issueTokens(
  payload: IssueTokensOptions & { email: string; username: string },
): Promise<IssuedTokens> {
  const refreshToken = uuidv4();
  const refreshTokenHash = hashToken(refreshToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

  const [session] = await db
    .insert(sessions)
    .values({
      userId: payload.userId,
      refreshTokenHash,
      userAgent: payload.userAgent ?? null,
      ipAddress: payload.ipAddress ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id });

  const accessToken = jwt.sign(
    {
      id: payload.userId,
      email: payload.email,
      username: payload.username,
      sessionId: session.id,
    },
    config.jwtSecret,
    { expiresIn: ACCESS_TOKEN_TTL },
  );

  return { accessToken, refreshToken, sessionId: session.id };
}

function mapUserToResponse(
  user: (typeof users.$inferSelect),
): AuthResponse['user'] {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function register(
  body: RegisterRequest,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<AuthResponse & { refreshToken: string }> {
  const existingEmail = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1);

  if (existingEmail.length > 0) {
    throw new AppError('Email already in use', 409);
  }

  const existingUsername = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);

  if (existingUsername.length > 0) {
    throw new AppError('Username already taken', 409);
  }

  const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

  const [user] = await db
    .insert(users)
    .values({ email: body.email, username: body.username, passwordHash })
    .returning();

  const tokens = await issueTokens({
    userId: user.id,
    email: user.email,
    username: user.username,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: mapUserToResponse(user),
  };
}

export async function login(
  body: LoginRequest,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<AuthResponse & { refreshToken: string }> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1);

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    throw new AppError('Invalid email or password', 401);
  }

  const tokens = await issueTokens({
    userId: user.id,
    email: user.email,
    username: user.username,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: mapUserToResponse(user),
  };
}

export async function logout(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function refresh(
  refreshToken: string,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<RefreshResponse & { refreshToken: string; sessionId: string }> {
  const tokenHash = hashToken(refreshToken);

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, tokenHash))
    .limit(1);

  if (!session) {
    throw new AppError('Invalid refresh token', 401);
  }

  if (session.expiresAt < new Date()) {
    await db.delete(sessions).where(eq(sessions.id, session.id));
    throw new AppError('Refresh token has expired', 401);
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    throw new AppError('User not found', 401);
  }

  // Rotate: delete old session, create new one
  await db.delete(sessions).where(eq(sessions.id, session.id));

  const newRefreshToken = uuidv4();
  const newRefreshTokenHash = hashToken(newRefreshToken);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

  const [newSession] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      refreshTokenHash: newRefreshTokenHash,
      userAgent: meta.userAgent ?? session.userAgent,
      ipAddress: meta.ipAddress ?? session.ipAddress,
      expiresAt,
    })
    .returning({ id: sessions.id });

  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username,
      sessionId: newSession.id,
    },
    config.jwtSecret,
    { expiresIn: ACCESS_TOKEN_TTL },
  );

  return { accessToken, refreshToken: newRefreshToken, sessionId: newSession.id };
}

export async function forgotPassword(email: string): Promise<void> {
  const [user] = await db
    .select({
      id: users.id,
      passwordResetTokenVersion: users.passwordResetTokenVersion,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    // No enumeration — silently return
    return;
  }

  // `v` binds the token to the current password-reset version. A successful
  // reset bumps the column atomically, so any prior token (replayed from logs,
  // email forwarding, etc.) fails the version check and is rejected.
  const resetToken = jwt.sign(
    { sub: user.id, v: user.passwordResetTokenVersion },
    config.jwtResetSecret,
    { expiresIn: '1h' },
  );

  // Email delivery is not wired up yet. In non-production, persist the token
  // to a gitignored dev-only file so flows can still be tested locally. In
  // production we silently drop — never log a bearer credential.
  if (config.nodeEnv !== 'production') {
    const artifactsDir = path.resolve(process.cwd(), '.dev-artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await appendFile(
      path.join(artifactsDir, 'password-resets.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), email, token: resetToken }) + '\n',
      'utf8',
    );
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  let payload: { sub: string; v: number };
  try {
    payload = jwt.verify(token, config.jwtResetSecret) as { sub: string; v: number };
  } catch {
    throw new AppError('Reset token is invalid or has expired', 400);
  }

  if (typeof payload.sub !== 'string' || typeof payload.v !== 'number') {
    throw new AppError('Reset token is invalid or has expired', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  // Atomic single-use enforcement: only the row whose version still matches
  // the token's `v` is updated, and the version is bumped in the same write.
  // A concurrent replay of the same token affects zero rows on the second pass.
  const result = await db
    .update(users)
    .set({
      passwordHash,
      passwordResetTokenVersion: sql`${users.passwordResetTokenVersion} + 1`,
    })
    .where(
      and(
        eq(users.id, payload.sub),
        eq(users.passwordResetTokenVersion, payload.v),
      ),
    )
    .returning({ id: users.id });

  if (result.length === 0) {
    throw new AppError('Reset token is invalid or has expired', 400);
  }

  // Invalidate all sessions after password reset
  await db.delete(sessions).where(eq(sessions.userId, payload.sub));
}

export async function getSessions(userId: string): Promise<(typeof sessions.$inferSelect)[]> {
  return db.select().from(sessions).where(eq(sessions.userId, userId));
}

export async function deleteSession(sessionId: string, userId: string): Promise<void> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);

  if (!session) {
    // Check if it exists at all for correct error
    const [anySession] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!anySession) {
      throw new AppError('Session not found', 404);
    }
    throw new AppError('Forbidden', 403);
  }

  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
