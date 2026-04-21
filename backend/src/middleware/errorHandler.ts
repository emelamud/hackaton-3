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

  // Honour client-error status codes from framework/middleware errors
  // (e.g. body-parser's PayloadTooLargeError with status 413) so the client
  // sees the right code; fall through to a generic 500 for real server bugs.
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: err.message });
    return;
  }

  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
}
