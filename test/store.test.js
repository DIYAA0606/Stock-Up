import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/store-file.js';
import { hashPin, checkPin } from '../src/auth.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gtg-store-test-'));
}

test('FileStore: fresh state initializes 12 companies and valid settings', async () => {
  const store = new FileStore(tmpDir());
  const st = await store.load();
  assert.equal(st.companies.length, 12);
  assert.equal(st.settings.rounds, 6);
  assert.equal(st.settings.startingCapital, '100');
  assert.ok(st.settings.adminPinHash);
  assert.ok(st.settings.coordinatorPinHash);
  assert.ok(checkPin(st.settings._adminPinPlain, st.settings.adminPinHash));
});

test('FileStore: saveAlloc writes granularly and deleteAlloc cleans up', async () => {
  const store = new FileStore(tmpDir());
  await store.saveAlloc('t1', 1, { amounts: { c1: '50' }, by: 'C01', at: Date.now() });
  await store.saveAlloc('t2', 1, { amounts: { c2: '75' }, by: 'C02', at: Date.now() });

  let st = await store.load();
  assert.deepEqual(st.allocations['t1'][1].amounts, { c1: '50' });
  assert.deepEqual(st.allocations['t2'][1].amounts, { c2: '75' });

  await store.deleteAlloc('t1');
  st = await store.load();
  assert.equal(st.allocations['t1'], undefined);
  assert.ok(st.allocations['t2']);
});

test('FileStore: coordinator CRUD and persistence', async () => {
  const dir = tmpDir();
  const store1 = new FileStore(dir);

  const pinHash = hashPin('123456');
  await store1.setCoordinator({
    id: 'coord-c01',
    code: 'C01',
    pinHash,
    assignedTeams: ['t1', 't2'],
    enabled: true,
    createdAt: Date.now(),
  });

  const c = await store1.getCoordinator('coord-c01');
  assert.ok(c);
  assert.equal(c.code, 'C01');
  assert.equal(c.enabled, true);
  assert.deepEqual(c.assignedTeams, ['t1', 't2']);

  // Verify persistence across new FileStore instance on same dir
  const store2 = new FileStore(dir);
  const coords = await store2.getCoordinators();
  assert.equal(coords.length, 1);
  assert.equal(coords[0].code, 'C01');

  await store2.deleteCoordinator('coord-c01');
  assert.equal(await store2.getCoordinator('coord-c01'), null);
});

test('FileStore: rate limiting sliding window', async () => {
  const store = new FileStore(tmpDir());
  const key = 'test-key';
  // Allow 3 requests per 10 seconds
  assert.equal(await store.recordFailAndCheck(key, 3, 10), false);
  assert.equal(await store.recordFailAndCheck(key, 3, 10), false);
  assert.equal(await store.recordFailAndCheck(key, 3, 10), false);
  // 4th request exceeds limit and triggers rate limit
  assert.equal(await store.recordFailAndCheck(key, 3, 10), true);
  assert.equal(await store.isRateLimited(key, 3, 10), true);
});

test('FileStore: board cache get, set, and invalidation', async () => {
  const store = new FileStore(tmpDir());
  assert.equal(await store.getBoardCache(), null);

  await store.setBoardCache('{"round":1}');
  assert.equal(await store.getBoardCache(), '{"round":1}');

  await store.invalidateBoardCache();
  assert.equal(await store.getBoardCache(), null);
});

test('FileStore: audit log recording and retrieval', async () => {
  const store = new FileStore(tmpDir());
  await store.audit('ADMIN', 'test.action', { foo: 'bar' });
  await store.audit('C01', 'chit.save', { team: 't1' });

  const lines = await store.getAuditLines(10);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].action, 'chit.save');
  assert.equal(lines[1].action, 'test.action');
});
