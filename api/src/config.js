import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// api/.env wins over the repo-root .env; real env vars (compose) win over both.
dotenv.config({ path: [join(API_DIR, '.env'), join(API_DIR, '..', '.env')] });

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: process.env.DB_USER ?? 'itc',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'itc_guard'
  }
};
