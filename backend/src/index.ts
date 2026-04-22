import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { roomsRouter } from './routes/rooms';
import { invitationsRouter, roomInvitationsRouter } from './routes/invitations';
import {
  friendshipsRouter,
  friendRequestsRouter,
  usersRouter,
} from './routes/friends';
import { dmRouter } from './routes/dm';
import { userBansRouter } from './routes/user-bans';
import { attachmentsRouter } from './routes/attachments';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimit';
import { initSocketIo } from './socket/io';
import * as attachmentsService from './services/attachments.service';
import { config } from './config';

const app = express();

if (config.nodeEnv === 'production') {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
    hsts:
      config.nodeEnv === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  }),
);

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.use('/api/', apiLimiter);

app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/auth/sessions', sessionsRouter);
// roomInvitationsRouter must be mounted BEFORE roomsRouter because Express
// matches in registration order — otherwise roomsRouter would claim
// /api/rooms/:id/* as a wildcard via its trailing handlers.
app.use('/api/rooms/:id/invitations', roomInvitationsRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/invitations', invitationsRouter);
app.use('/api/friends', friendshipsRouter);
app.use('/api/friend-requests', friendRequestsRouter);
app.use('/api/users', usersRouter);
app.use('/api/dm', dmRouter);
app.use('/api/user-bans', userBansRouter);
app.use('/api/attachments', attachmentsRouter);

app.use(errorHandler);

const httpServer = http.createServer(app);
initSocketIo(httpServer, config.corsOrigins);

// Prepare the uploads volume BEFORE accepting connections — first-run case
// where the named volume is empty and no `<yyyy>/<mm>` dirs exist yet; this
// also fails fast (startup crash, not first-upload 500) if the path is
// unwriteable. No-op when the volume already has files.
async function start(): Promise<void> {
  await fs.promises.mkdir(config.uploadsDir, { recursive: true });
  console.log(`Uploads directory ready at ${config.uploadsDir}`);

  // Round 8 — orphan sweep. Run once at startup (so a restart doesn't
  // delay cleanup up to 10 min), then on a fixed 10-minute interval.
  // Errors are logged and swallowed — a sweep failure must not crash the
  // process.
  const runSweep = async (): Promise<void> => {
    try {
      const { deletedCount } = await attachmentsService.sweepPendingAttachments();
      if (deletedCount > 0) {
        console.log(`Attachment sweep: deleted ${deletedCount} orphan(s)`);
      }
    } catch (err) {
      console.warn('Attachment sweep failed', err);
    }
  };
  void runSweep();
  setInterval(() => void runSweep(), 10 * 60 * 1000);

  httpServer.listen(config.port, () => {
    console.log(`Backend running on port ${config.port}`);
  });
}

void start();
