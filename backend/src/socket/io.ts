import type http from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { verifyAccessToken, type AuthPayload } from '../middleware/auth';
import { AppError } from '../errors/AppError';
import * as roomsService from '../services/rooms.service';
import * as messagesService from '../services/messages.service';
import * as presenceService from '../services/presence.service';
import * as presenceInterestService from '../services/presence-interest.service';
import type {
  MessageSendAck,
  SendMessagePayload,
  ServerToClientEvents,
} from '@shared';

// Round 7 — `Server` is left ungenericised on purpose. Wiring the
// `ClientToServerEvents` / `ServerToClientEvents` generics would require us
// to also migrate the Round-3 `message:send` ad-hoc (payload, ack) signature,
// which sits outside the current `ClientToServerEvents` definition. The new
// `presence:active` / `presence:idle` names still type-check at runtime
// because socket.io matches by string; keeping the old generics avoids a
// wide refactor for Round 7.

let ioInstance: Server | null = null;

export function getIo(): Server {
  if (!ioInstance) {
    throw new Error('Socket.io not initialised');
  }
  return ioInstance;
}

/**
 * Emit a server→client event to all sockets in `user:<userId>`.
 * Keeps event-name and payload types in lock-step with the shared contract.
 */
export function emitToUser<E extends keyof ServerToClientEvents>(
  userId: string,
  event: E,
  payload: ServerToClientEvents[E],
): void {
  getIo().in(`user:${userId}`).emit(event, payload);
}

/**
 * Emit a server→client event to all sockets in `room:<roomId>`.
 * Keeps event-name and payload types in lock-step with the shared contract.
 */
export function emitToRoom<E extends keyof ServerToClientEvents>(
  roomId: string,
  event: E,
  payload: ServerToClientEvents[E],
): void {
  getIo().in(`room:${roomId}`).emit(event, payload);
}

const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  body: z.string(),
});

// Per-socket token bucket for `message:send`: 5 messages/sec refill, burst 10.
// Sized around the 3072-char message cap; far above any human typing cadence.
const MESSAGE_BUCKET_CAPACITY = 10;
const MESSAGE_REFILL_PER_SEC = 5;
const messageBuckets = new WeakMap<Socket, { tokens: number; ts: number }>();

function allowMessage(socket: Socket): boolean {
  const now = Date.now();
  const prev = messageBuckets.get(socket) ?? { tokens: MESSAGE_BUCKET_CAPACITY, ts: now };
  const refill = ((now - prev.ts) / 1000) * MESSAGE_REFILL_PER_SEC;
  const tokens = Math.min(MESSAGE_BUCKET_CAPACITY, prev.tokens + refill);
  if (tokens < 1) {
    messageBuckets.set(socket, { tokens, ts: now });
    return false;
  }
  messageBuckets.set(socket, { tokens: tokens - 1, ts: now });
  return true;
}

export function initSocketIo(
  httpServer: http.Server,
  corsOrigin: string | readonly string[],
): Server {
  const io = new Server(httpServer, {
    cors: {
      // Socket.io forwards this to the underlying CORS impl; both a single
      // string and a string[] are accepted.
      origin: corsOrigin as string | string[],
      credentials: true,
    },
    // Well above the 3072-char message cap; blocks >1MB default that would
    // let one socket exhaust memory parsing a single frame.
    maxHttpBufferSize: 16 * 1024,
  });

  // JWT auth middleware — shares `verifyAccessToken` with HTTP `requireAuth`.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length === 0) {
        next(new Error('Unauthorized'));
        return;
      }
      const user = verifyAccessToken(token);
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const user = socket.data.user as AuthPayload;
    const userId = user.id;

    // 1. User-scoped room (fan-out across a user's tabs + REST-handler nudges).
    await socket.join(`user:${userId}`);

    // 2. One Socket.io room per chat room the user currently belongs to.
    try {
      const rooms = await roomsService.listRoomsForUser(userId);
      for (const r of rooms) {
        await socket.join(`room:${r.id}`);
      }
    } catch (err) {
      // Don't kill the socket — they just won't receive broadcasts until
      // REST-driven `socketsJoin` nudges sync state.
      // eslint-disable-next-line no-console
      console.error('Failed to pre-subscribe socket to rooms', err);
    }

    // 3. Presence — Round 7.
    //    - Fresh sockets start as `active`.
    //    - Snapshot is per-SOCKET (socket.emit), NOT per-user (emitToUser) so
    //      opening a new tab does not re-hydrate every other tab of the same user.
    //    - The self-transition broadcast goes to the caller's interest set when
    //      the aggregate actually changes (e.g. `offline → online` on first tab).
    try {
      const { changed, state } = presenceService.handleConnect(socket.id, userId);
      const interest = await presenceInterestService.getInterestSet(userId);
      socket.emit('presence:snapshot', {
        presences: presenceService.snapshotForUsers(interest),
      });
      if (changed) {
        for (const otherId of interest) {
          emitToUser(otherId, 'presence:update', { userId, state });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to initialise presence on connect', err);
    }

    // 4. Presence — disconnect handler. Removes the socket from the registry,
    //    fan-outs the resulting aggregate change if any (e.g. last active socket
    //    gone → `afk`, last connected socket gone → `offline`).
    socket.on('disconnect', async () => {
      try {
        const { userId: uid, changed, state } = presenceService.handleDisconnect(
          socket.id,
        );
        if (!uid || !changed) return;
        const interest = await presenceInterestService.getInterestSet(uid);
        for (const otherId of interest) {
          emitToUser(otherId, 'presence:update', { userId: uid, state });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to handle presence on disconnect', err);
      }
    });

    // 5. Presence — client-driven activity transitions.
    //    Shared body between `presence:active` and `presence:idle`; extracted
    //    into a closure to keep both branches identical.
    const broadcastActivity = async (activity: 'active' | 'idle'): Promise<void> => {
      try {
        const { userId: uid, changed, state } = presenceService.setSocketActivity(
          socket.id,
          activity,
        );
        if (!uid || !changed) return;
        const interest = await presenceInterestService.getInterestSet(uid);
        for (const otherId of interest) {
          emitToUser(otherId, 'presence:update', { userId: uid, state });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Failed to handle presence:${activity}`, err);
      }
    };

    socket.on('presence:active', () => {
      void broadcastActivity('active');
    });
    socket.on('presence:idle', () => {
      void broadcastActivity('idle');
    });

    socket.on(
      'message:send',
      async (payload: SendMessagePayload, ack?: (res: MessageSendAck) => void) => {
        // Ack is mandatory per the contract — drop silently if the client
        // forgot to pass a callback; there's nowhere to return an error to.
        if (typeof ack !== 'function') return;

        try {
          if (!allowMessage(socket)) {
            throw new AppError('Rate limit exceeded', 429);
          }

          // Defensive payload shape check so malformed input gets the
          // documented "Invalid payload" string instead of a stack trace.
          const parsed = sendMessageSchema.safeParse(payload);
          if (!parsed.success) {
            throw new AppError('Invalid payload', 400);
          }

          const body = parsed.data.body.trim();
          const message = await messagesService.persistMessage(
            userId,
            parsed.data.roomId,
            body,
          );

          ack({ ok: true, message });

          // Broadcast to everyone in the room EXCEPT the sending socket.
          // Sender renders from the ack; other tabs of the same user get
          // this broadcast since they are different sockets.
          socket.to(`room:${message.roomId}`).emit('message:new', message);
        } catch (err) {
          const errorString = err instanceof AppError ? err.message : 'Internal error';
          if (!(err instanceof AppError)) {
            // eslint-disable-next-line no-console
            console.error('message:send failed', err);
          }
          ack({ ok: false, error: errorString });
        }
      },
    );
  });

  ioInstance = io;
  return io;
}
