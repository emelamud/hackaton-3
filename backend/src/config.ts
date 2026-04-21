const PLACEHOLDER_SECRETS = new Set([
  'change-me',
  'change-me-too',
  'change-me-three',
  'secret',
  'changeme',
  'password',
]);

function require_env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function requireJwtSecret(name: string, isProduction: boolean): string {
  const val = require_env(name);
  if (PLACEHOLDER_SECRETS.has(val)) {
    throw new Error(
      `${name} is a known placeholder — generate a strong secret, e.g. 'openssl rand -base64 48'`,
    );
  }
  if (isProduction && val.length < 32) {
    throw new Error(`${name} must be at least 32 characters in production`);
  }
  return val;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

const jwtSecret = requireJwtSecret('JWT_SECRET', isProduction);
const jwtRefreshSecret = requireJwtSecret('JWT_REFRESH_SECRET', isProduction);
const jwtResetSecret = requireJwtSecret('JWT_RESET_SECRET', isProduction);

if (isProduction) {
  const secrets = [jwtSecret, jwtRefreshSecret, jwtResetSecret];
  if (new Set(secrets).size !== secrets.length) {
    throw new Error(
      'JWT_SECRET, JWT_REFRESH_SECRET, and JWT_RESET_SECRET must be distinct in production',
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: require_env('DATABASE_URL'),
  jwtSecret,
  jwtRefreshSecret,
  jwtResetSecret,
  nodeEnv,
  uploadsDir: process.env.UPLOADS_DIR ?? '/app/uploads',
} as const;
