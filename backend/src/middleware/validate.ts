import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { AppError } from '../errors/AppError';

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      next(new AppError('Validation failed', 400, details));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      next(new AppError('Validation failed', 400, details));
      return;
    }
    // Express 4 keeps req.params mutable as a plain object
    Object.assign(req.params, result.data);
    next();
  };
}

// Round 9 — query-string variant. Mirrors the body `validate` middleware so
// the wire-error shape stays identical (`{ error: "Validation failed",
// details: [...] }`). Coercing schemas (`z.coerce.number().default(...)`)
// work transparently — the parsed `result.data` lands on `req.query` in the
// correct typed shape for the handler.
export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      next(new AppError('Validation failed', 400, details));
      return;
    }
    // Replace — `req.query` in Express 4 is a plain object; reassigning is
    // safe and lets `z.coerce` outputs reach the handler with numeric types.
    Object.assign(req.query, result.data);
    next();
  };
}
