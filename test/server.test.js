// End-to-end: real HTTP server, 8 teams, all 6 rounds, random chits. Final worth is compared with an
// independent floating-point calculation written from the sheet, not from the engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { SEED_CSV } from '../src/seed.js';

let server, base, store, ADMIN, COORD;

before(async () => {
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'gtg-e2e-')));
  ADMIN = store.state.settings.pins.admin;
  COORD = store.state.settings.pins.coordinator;
  server = createApp(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, { pin, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-pin': pin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
const admin = (m, u, body) => call(m, '/api/admin/' + u, { pin: ADMIN, body });

// independent model of the sheet
const sheet = SEED_CSV.split('\n').slice(1).map((l) => {
  const [name, ...cells] = l.split('\t');
  return { name, g: cells.map((c) => (c.endsWith('%') ? parseFloat(c) / 100 : parseFloat(c))) };
});
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('PIN protection', async () => {
  assert.equal((await call('GET', '/api/entry')).status, 401);
  assert.equal((await call('GET', '/api/entry', { pin: '0000' })).status, 401);
  assert.equal((await call('GET', '/api/admin/state', { pin: COORD })).status, 403);
  assert.equal((await call('POST', '/api/login', { body: { pin: ADMIN } })).data.role, 'admin');
  assert.equal((await call('POST', '/api/login', { body: { pin: COORD } })).data.role, 'coordinator');
  assert.equal((await call('GET', '/api/board')).status, 200); // projector needs no PIN
});

test('static pages are served and path traversal is blocked', async () => {
  assert.equal((await call('GET', '/')).status, 200);
  const evil = await fetch(base + '/..%2f..%2fpackage.json');
  assert.ok([403, 404].includes(evil.status));
});

test('full 6-round event with 8 teams matches an independent calculation', async () => {
  const names = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6', 'Team 7', 'Team 8'];
  assert.equal((await admin('POST', 'teams', { names })).status, 200);
  const rand = mulberry32(2026);
  const model = Object.fromEntries(names.map((n) => [n, 100]));

  for (let round = 1; round <= 6; round++) {
    await admin('POST', 'news', { round, items: [{ headline: `Round ${round} headline`, body: 'Body' }] });
    // news -> investing -> entry
    await admin('POST', 'advance', {});
    await admin('POST', 'advance', {});
    let pub = (await call('GET', '/api/board')).data;
    assert.equal(pub.phase, 'entry');
    assert.equal(pub.companies[0].growth.length, round - 1, 'growth must only be public for finished rounds');

    const ctx = (await call('GET', '/api/entry', { pin: COORD })).data;
    assert.equal(ctx.writable, true);
    assert.ok(!JSON.stringify(ctx).includes('growth'));
    for (const t of ctx.teams) {
      const capCents = Math.floor(Number(t.capitalStart) * 100);
      assert.equal(Math.round(model[t.name] * 100) / 100, Math.round(Number(t.capitalStart) * 100) / 100, 'capital start matches model');
      const k = 3 + Math.floor(rand() * 5);
      const picks = [...ctx.companies].sort(() => rand() - 0.5).slice(0, k);
      const spend = Math.floor(capCents * (0.4 + rand() * 0.6));
      const amounts = {};
      let left = spend;
      picks.forEach((c, i) => {
        const part = i === picks.length - 1 ? left : Math.floor(left * rand() * 0.7);
        amounts[c.id] = (part / 100).toFixed(2);
        left -= part;
      });
      const r = await call('POST', '/api/entry', { pin: COORD, body: { teamId: t.id, round, amounts } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      // update the independent model with what was actually entered
      let invested = 0;
      let exit = 0;
      for (const [cid, v] of Object.entries(amounts)) {
        const amt = Number(v);
        invested += amt;
        exit += amt * (1 + sheet[Number(cid.slice(1)) - 1].g[round - 1]);
      }
      model[t.name] = model[t.name] - invested + exit;
    }
    // one over-budget chit must be refused and leave the saved one alone
    const t0 = ctx.teams[0];
    const bad = await call('POST', '/api/entry', { pin: COORD, body: { teamId: t0.id, round, amounts: { c1: '1000' } } });
    assert.equal(bad.status, 422);

    assert.equal((await admin('POST', 'advance', {})).status, 200); // -> revealed
    pub = (await call('GET', '/api/board')).data;
    assert.equal(pub.phase, 'revealed');
    assert.equal(pub.companies[0].growth.length, round);
    for (const t of pub.teams) assert.ok(Math.abs(Number(t.worth) - model[t.name]) < 0.001, `${t.name} round ${round}: ${t.worth} vs ${model[t.name]}`);
    // leaderboard order is by worth, descending
    const worths = pub.teams.map((t) => Number(t.worth));
    assert.deepEqual(worths, [...worths].sort((a, b) => b - a));
    if (round < 6) await admin('POST', 'advance', {});
  }

  // final: step through the reveal
  await admin('POST', 'advance', {});
  let fin = (await call('GET', '/api/board')).data;
  assert.equal(fin.phase, 'final');
  assert.ok(fin.teams.every((t) => t.hidden));
  for (let i = 0; i < 8; i++) await admin('POST', 'final', { action: 'next' });
  fin = (await call('GET', '/api/board')).data;
  assert.ok(fin.teams.every((t) => !t.hidden));
  assert.equal(fin.teams.length, 8);

  // exports and logs
  const csv = await fetch(base + '/api/admin/export.csv', { headers: { 'x-pin': ADMIN } });
  const text = await csv.text();
  assert.equal(text.trim().split('\n').length, 1 + 8 * 6);
  const audit = (await admin('GET', 'audit')).data.lines;
  assert.ok(audit.some((l) => l.action === 'entry.set'));
  assert.ok(fs.readdirSync(store.backupDir).length >= 6, 'a backup is written at every reveal');
});
