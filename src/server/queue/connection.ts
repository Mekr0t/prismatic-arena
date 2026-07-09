import { URL } from 'node:url';
import type { ConnectionOptions } from 'bullmq';

// BullMQ manages its own Redis connections. We hand it connection *options*
// (not a shared ioredis instance) so there's no dual-package coupling between
// the app's ioredis and BullMQ's bundled copy, and BullMQ can apply the
// blocking-connection settings it needs. Parsed from the same REDIS_URL the app
// uses; defaults match the dev docker setup.
//
// rediss:// (TLS): add a `tls: {}` option below if your hosted Redis needs it.
function connectionFromEnv(): ConnectionOptions {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export const bullConnection: ConnectionOptions = connectionFromEnv();
