import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { roomsRouter } from './routes/rooms';
import { invitationsRouter, roomInvitationsRouter } from './routes/invitations';
import { errorHandler } from './middleware/errorHandler';
import { initSocketIo } from './socket/io';
import { config } from './config';

const app = express();

const CORS_ORIGIN = 'http://localhost:4300';

app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

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
