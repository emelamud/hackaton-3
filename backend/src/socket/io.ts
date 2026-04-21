import type http from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { verifyAccessToken, type AuthPayload } from '../middleware/auth';
import { AppError } from '../errors/AppError';
import * as roomsService from '../services/rooms.service';
import * as messagesService from '../services/messages.service';
import type { MessageSendAck, SendMessagePayload } from '../types/shared';

let ioInstance: Server | null = null;

export function getIo(): Server {
  if (!ioInstance) {
    throw new Error('Socket.io not initialised');
  }
  return ioInstance;
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

export function initSocketIo(httpServer: http.Server, corsOrigin: string): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
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
