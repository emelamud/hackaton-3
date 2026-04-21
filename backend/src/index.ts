import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { roomsRouter } from './routes/rooms';
import { invitationsRouter, roomInvitationsRouter } from './routes/invitations';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimit';
import { initSocketIo } from './socket/io';
import { config } from './config';

const app = express();

if (config.nodeEnv === 'production') {
  app.set('trust proxy', 1);
}

const CORS_ORIGIN = 'http://localhost:4300';

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
    origin: CORS_ORIGIN,
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

app.use(errorHandler);

const httpServer = http.createServer(app);
initSocketIo(httpServer, CORS_ORIGIN);

httpServer.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`);
});
