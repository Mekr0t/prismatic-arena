import Redis from 'ioredis';

if (!process.env.REDIS_URL && process.env.NODE_ENV === 'production') {
  throw new Error('REDIS_URL environment variable is required in production');
}
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Reuse one client across Next.js hot reloads in development.
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ?? new Redis(url, { maxRetriesPerRequest: 3 });

// Prevent Node from crashing on unhandled connection errors (e.g. Redis not
// running locally). Per-request errors are still thrown to callers normally.
redis.on('error', () => {});

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;
