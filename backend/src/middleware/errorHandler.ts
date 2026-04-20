import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';

export function errorHandler(
  err: Error & { details?: unknown[] },
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
): void {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.details && err.details.length > 0) {
      body.details = err.details;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
}
