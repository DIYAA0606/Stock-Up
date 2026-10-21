// Store factory — picks the right implementation based on env vars.
//
//   UPSTASH_REDIS_REST_URL set  →  RedisStore  (Vercel production)
//   KV_REST_API_URL set        →  RedisStore  (Vercel KV integration alias)
//   otherwise                  →  FileStore   (local dev / npm start / npm test)
//
// Usage:
//   import { createStore } from './store.js';
//   const store = await createStore();

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create and return the appropriate store instance.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]    Override the data directory for FileStore (default: project root)
 * @param {object} [opts.redis]  Inject a custom Redis client for testing
 * @returns {Promise<import('./store-file.js').FileStore | import('./store-redis.js').RedisStore>}
 */
export async function createStore(opts = {}) {
  const useRedis = !!(
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL
  );

  if (useRedis) {
    const { RedisStore } = await import('./store-redis.js');
    return new RedisStore(opts);
  }

  const { FileStore } = await import('./store-file.js');
  const dir = opts.dir || path.join(__dirname, '..');
  return new FileStore(dir);
}

export { FileStore, FileStore as Store } from './store-file.js';
