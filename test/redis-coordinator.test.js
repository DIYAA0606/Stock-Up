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
  zadd() { this.operations.push(() => 1); return this; }
  expire() { this.operations.push(() => 1); return this; }
  set(key, value) { this.operations.push(() => this.redis.set(key, value)); return this; }
  del(key) { this.operations.push(() => this.redis.del(key)); return this; }
  hset(key, entries) { this.operations.push(() => this.redis.hset(key, entries)); return this; }
  hgetall(key) { this.operations.push(() => this.redis.hgetall(key)); return this; }
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
  async exec() { return Promise.all(this.operations.map((operation) => operation())); }
}

class FakeUpstashRedis {
  constructor() {
    this.values = new Map();
    this.hashes = new Map();
    this.lists = new Map();
  }

  async get(key) { return autoParse(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, value); return 'OK'; }
  async del(key) { this.values.delete(key); this.hashes.delete(key); return 1; }
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
  const previousAdminPin = process.env.ADMIN_PIN;
  const previousCoordinatorPin = process.env.COORDINATOR_PIN;
  const previousSessionSecret = process.env.SESSION_SECRET;
  process.env.ADMIN_PIN = 'fake-redis-admin-pin';
  process.env.SESSION_SECRET = 'fake-redis-session-secret';
  delete process.env.COORDINATOR_PIN;
  t.after(() => {
    if (previousAdminPin === undefined) delete process.env.ADMIN_PIN;
    else process.env.ADMIN_PIN = previousAdminPin;
    if (previousCoordinatorPin === undefined) delete process.env.COORDINATOR_PIN;
    else process.env.COORDINATOR_PIN = previousCoordinatorPin;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  });

  const store = new RedisStore({ redis: new FakeUpstashRedis() });
  assert.equal((await store.load()).settings.coordinatorPinHash, null);
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

  const addedTeams = await call('POST', '/api/admin/teams', { names: ['Team 1', 'Team 2'] });
  assert.equal(addedTeams.status, 200);

  const generated = await call('POST', '/api/admin/coordinators/generate', { count: 2 });
  assert.equal(generated.status, 200);
  const coordinator = generated.data.created[0];
  const originalPin = coordinator.pin;
  const listedBeforeReset = await call('GET', '/api/admin/coordinators');
  assert.equal(listedBeforeReset.data.coordinators.find((c) => c.id === coordinator.id).pin, originalPin);
  assert.deepEqual(
    listedBeforeReset.data.coordinators.map((c) => c.assignedTeams.length).sort(),
    [1, 1],
  );
  const generatedLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: coordinator.code, pin: coordinator.pin }),
  });
  assert.equal(generatedLogin.status, 200);

  const reset = await call('POST', '/api/admin/coordinators/reset-pin', { coordId: coordinator.id });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.data.pin, originalPin);
  const listed = await call('GET', '/api/admin/coordinators');
  assert.equal(listed.data.coordinators[0].pin, reset.data.pin);

  const oldPinLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: coordinator.code, pin: originalPin }),
  });
  assert.equal(oldPinLogin.status, 401);

  const resetLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: coordinator.code, pin: reset.data.pin }),
  });
  assert.equal(resetLogin.status, 200);

  const addedTeamAfterCoordinator = await call('POST', '/api/admin/teams', { names: ['Team 3'] });
  assert.equal(addedTeamAfterCoordinator.status, 200);
  const reassigned = await call('GET', '/api/admin/coordinators');
  assert.deepEqual(
    reassigned.data.coordinators.map((c) => c.assignedTeams.length).sort(),
    [1, 2],
  );
});

test('Redis mode requires ADMIN_PIN and has no shared coordinator PIN by default', async () => {
  const previousAdminPin = process.env.ADMIN_PIN;
  const previousCoordinatorPin = process.env.COORDINATOR_PIN;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.ADMIN_PIN;
  delete process.env.COORDINATOR_PIN;
  process.env.SESSION_SECRET = 'fake-redis-session-secret';
  let server;
  try {
    const store = new RedisStore({ redis: new FakeUpstashRedis() });
    await assert.rejects(store.load(), /ADMIN_PIN environment variable/);
    server = createApp(store);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/board`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /ADMIN_PIN environment variable/);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (previousAdminPin === undefined) delete process.env.ADMIN_PIN;
    else process.env.ADMIN_PIN = previousAdminPin;
    if (previousCoordinatorPin === undefined) delete process.env.COORDINATOR_PIN;
    else process.env.COORDINATOR_PIN = previousCoordinatorPin;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
