// Vercel Serverless entry-point for the API.
//
// KEY CHANGE: The store is created fresh per-request using the factory.
// RedisStore uses Upstash REST HTTP — it has no persistent connection,
// so creating it per-request is cheap and correct for serverless.
// FileStore is also instantiated per-request but re-reads from disk only
// when needed (it caches state in-memory on construction).
//
// This eliminates the "different lambda = different in-memory state" bug
// that caused the site to be unreliable under concurrent traffic.

import { createStore } from '../src/store.js';
import { createRequestHandler } from '../src/server.js';

export default async function (req, res) {
  const store = await createStore();
  const handler = createRequestHandler(store);
  return handler(req, res);
}
