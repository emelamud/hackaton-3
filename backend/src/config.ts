function require_env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: require_env('DATABASE_URL'),
  jwtSecret: require_env('JWT_SECRET'),
  jwtRefreshSecret: require_env('JWT_REFRESH_SECRET'),
  jwtResetSecret: require_env('JWT_RESET_SECRET'),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  uploadsDir: process.env.UPLOADS_DIR ?? '/app/uploads',
} as const;
