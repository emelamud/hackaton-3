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

export function initSocketIo(httpServer: http.Server, corsOrigin: string): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
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
