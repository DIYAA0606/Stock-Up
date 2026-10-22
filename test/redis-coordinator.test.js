import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { RedisStore } from '../src/store-redis.js';
import { signToken } from '../src/auth.js';

function autoParse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

class FakePipeline {
  constructor(redis) {
    this.redis = redis;
    this.operations = [];
  }

  zremrangebyscore() { this.operations.push(() => 0); return this; }
  zcard() { this.operations.push(() => 0); return this; }
  lpush(key, value) {
    this.operations.push(() => {
      const list = this.redis.lists.get(key) || [];
      list.unshift(value);
      this.redis.lists.set(key, list);
      return list.length;
    });
    return this;
  }
  ltrim() { this.operations.push(() => 'OK'); return this; }
  async exec() { return this.operations.map((operation) => operation()); }
}

class FakeUpstashRedis {
  constructor() {
    this.values = new Map();
    this.hashes = new Map();
    this.lists = new Map();
  }

  async get(key) { return autoParse(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, value); return 'OK'; }
  async hset(key, entries) {
    const hash = this.hashes.get(key) || {};
    for (const [field, value] of Object.entries(entries)) hash[field] = value;
    this.hashes.set(key, hash);
    return Object.keys(entries).length;
  }
  async hgetall(key) {
    return Object.fromEntries(Object.entries(this.hashes.get(key) || {}).map(([field, value]) => [field, autoParse(value)]));
  }
  async hget(key, field) { return autoParse(this.hashes.get(key)?.[field] ?? null); }
  pipeline() { return new FakePipeline(this); }
}

test('Redis coordinator PINs work after generation and reset', async (t) => {
  const store = new RedisStore({ redis: new FakeUpstashRedis() });
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const adminToken = signToken({ role: 'admin', coordId: 'ADMIN' });
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };

  const generated = await call('POST', '/api/admin/coordinators/generate', { count: 1 });
  assert.equal(generated.status, 200);
  const coordinator = generated.data.created[0];
  const generatedLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: coordinator.code, pin: coordinator.pin }),
  });
  assert.equal(generatedLogin.status, 200);

  const reset = await call('POST', '/api/admin/coordinators/reset-pin', { coordId: coordinator.id });
  assert.equal(reset.status, 200);
  const listed = await call('GET', '/api/admin/coordinators');
  assert.equal(listed.data.coordinators[0].pin, reset.data.pin);

  const resetLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: coordinator.code, pin: reset.data.pin }),
  });
  assert.equal(resetLogin.status, 200);
});
