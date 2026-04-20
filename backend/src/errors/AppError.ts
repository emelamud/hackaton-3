export class AppError extends Error {
  public readonly statusCode: number;
  public details?: unknown[];

  constructor(message: string, statusCode: number, details?: unknown[]) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
