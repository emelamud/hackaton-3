import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { roomsRouter } from './routes/rooms';
import { errorHandler } from './middleware/errorHandler';
import { config } from './config';

const app = express();

app.use(
  cors({
    origin: 'http://localhost:4300',
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/auth/sessions', sessionsRouter);
app.use('/api/rooms', roomsRouter);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Backend running on port ${config.port}`);
});
