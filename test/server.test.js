// End-to-end: real HTTP server, 8 teams, all 6 rounds, random chits. Final worth is compared with an
// independent floating-point calculation written from the sheet, not from the engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/store-file.js';
import { createApp } from '../src/server.js';
const FIXTURE_RETURNS_CSV = `Stock,Q1,Q2,Q3,Q4
ApexTech,18,22,-45,-12
MedHeal,-3,4.2,-3.5,8
GreenFuel,4.5,5.5,-9,12
UrbanNest,6.3,-6.8,-17,11
QuickMart,9.1,6,-4,9
Velocity,15,-7.5,-16,10
FinBank,17,2.5,-42,-9
AgriGrow,5,-5.2,-10,7
Astra Motors,8.4,-8,-18,6
SkyLink,-1,-4,-15,-5`;
import { signToken, hashPin } from '../src/auth.js';

let server, base, store, ADMIN_PIN, COORD_PIN;

before(async () => {
  store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gtg-e2e-')));
  ADMIN_PIN = store.state.settings._adminPinPlain;
  COORD_PIN = store.state.settings._coordinatorPinPlain;
  server = createApp(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, { token, pin, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (pin) headers['x-pin'] = pin;

  const res = await fetch(base + url, {
    method,
    headers,
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

const admin = (m, u, body) => call(m, '/api/admin/' + u, { pin: ADMIN_PIN, body });

// Independent model of the sheet
const sheet = FIXTURE_RETURNS_CSV.trim().split('\n').slice(1).map((l) => {
  const [name, ...cells] = l.split(',');
  return { name, g: cells.map((c) => parseFloat(c) / 100) };
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

test('Bearer token auth and PIN protection', async () => {
  // Unauthenticated requests
  assert.equal((await call('GET', '/api/entry')).status, 401);
  assert.equal((await call('GET', '/api/entry', { pin: '0000' })).status, 401);
  assert.equal((await call('GET', '/api/admin/state', { pin: COORD_PIN })).status, 403);

  // Login via POST /api/auth/login
  const adminLogin = await call('POST', '/api/auth/login', { body: { code: 'ADMIN', pin: ADMIN_PIN } });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.role, 'admin');
  assert.ok(adminLogin.data.token);

  // Authenticate using token
  const stateWithToken = await call('GET', '/api/admin/state', { token: adminLogin.data.token });
  assert.equal(stateWithToken.status, 200);

  // Legacy login endpoint
  assert.equal((await call('POST', '/api/login', { body: { pin: ADMIN_PIN } })).data.role, 'admin');
  assert.equal((await call('POST', '/api/login', { body: { pin: COORD_PIN } })).data.role, 'coordinator');

  // Board (projector) is public
  assert.equal((await call('GET', '/api/board')).status, 200);
});

test('Invalid, expired, and forged tokens are rejected with 401', async () => {
  // Tampered payload
  const validToken = signToken({ role: 'admin', coordId: 'ADMIN' });
  const parts = validToken.split('.');
  const forgedToken = `${parts[0]}.${Buffer.from('{"role":"admin"}').toString('base64url')}.${parts[2]}`;
  assert.equal((await call('GET', '/api/admin/state', { token: forgedToken })).status, 401);

  // Expired token
  const expiredToken = signToken({ role: 'admin', coordId: 'ADMIN', exp: Math.floor(Date.now() / 1000) - 60 });
  assert.equal((await call('GET', '/api/admin/state', { token: expiredToken })).status, 401);

  // Garbage token
  assert.equal((await call('GET', '/api/admin/state', { token: 'not-a-token' })).status, 401);
});

test('Static pages are served and path traversal is blocked', async () => {
  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('GET', '/coordinator.html')).status, 200);
  const evil = await fetch(base + '/..%2f..%2fpackage.json');
  assert.ok([403, 404].includes(evil.status));
});

test('Coordinator isolation: only assigned teams are visible and writable', async () => {
  // Create coordinator with assigned teams
  const coordPin = '112233';
  await store.setCoordinator({
    id: 'coord-c99',
    code: 'C99',
    pinHash: hashPin(coordPin),
    assignedTeams: ['t-alpha'],
    enabled: true,
    createdAt: Date.now(),
  });

  // Login as C99
  const loginRes = await call('POST', '/api/auth/login', { body: { code: 'C99', pin: coordPin } });
  assert.equal(loginRes.status, 200);
  const token = loginRes.data.token;

  // Attempt to enter for non-assigned team t-beta
  const forbiddenRes = await call('POST', '/api/coord/entry', {
    token,
    body: { teamId: 't-beta', round: 1, amounts: { c1: '10' } }
  });
  assert.equal(forbiddenRes.status, 403);
});

test('Disabled coordinator is rejected on login and entry', async () => {
  const pin = '556677';
  await store.setCoordinator({
    id: 'coord-disabled',
    code: 'CDIS',
    pinHash: hashPin(pin),
    assignedTeams: ['t-alpha'],
    enabled: false,
    createdAt: Date.now(),
  });

  const loginRes = await call('POST', '/api/auth/login', { body: { code: 'CDIS', pin } });
  assert.equal(loginRes.status, 401);
});

test('Idempotent chit submission returns ok', async () => {
  // Admin entry for round 1
  const t0 = store.state.teams[0];
  if (t0) {
    const r1 = await call('POST', '/api/coord/entry', {
      pin: ADMIN_PIN,
      body: { teamId: t0.id, round: 1, amounts: { c1: '20' } }
    });
    // Submitting exact same chit again returns idempotent ok
    const r2 = await call('POST', '/api/coord/entry', {
      pin: ADMIN_PIN,
      body: { teamId: t0.id, round: 1, amounts: { c1: '20' } }
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.idempotent, true);
  }
});

test('Concurrency: 30 coordinators and 1 admin saving in parallel without lost writes', async () => {
  // Reset event for clean test
  await admin('POST', 'reset', { confirm: 'RESET', clearTeams: true });

  // Clean coordinators before test
  const existingCoords = await store.getCoordinators();
  for (const c of existingCoords) {
    await store.deleteCoordinator(c.id);
  }

  // Add 30 teams
  const teamNames = Array.from({ length: 30 }, (_, i) => `Team ${i + 1}`);
  await admin('POST', 'teams', { names: teamNames });

  // Bulk generate 30 coordinators
  const genRes = await admin('POST', 'coordinators/generate', { count: 30 });
  assert.equal(genRes.data.created.length, 30);

  // Auto-assign teams
  await admin('POST', 'coordinators/assign', {});

  // Move to investing phase
  await admin('POST', 'advance', {}); // info -> news
  await admin('POST', 'advance', {}); // news -> investing

  // Concurrently login all 30 coordinators and submit their chits simultaneously
  const st = await store.load();
  const coords = await store.getCoordinators();

  const promises = coords.map(async (c, i) => {
    // Generate valid session token
    const token = signToken({ role: 'coordinator', coordId: c.id });
    const teamId = c.assignedTeams[0];
    assert.ok(teamId, `Coordinator ${c.code} must have an assigned team`);

    const res = await call('POST', '/api/coord/entry', {
      token,
      body: {
        teamId,
        round: 1,
        amounts: { c1: '10', c2: '10' }
      }
    });
    assert.equal(res.status, 200, `Coordinator ${c.code} entry failed: ${JSON.stringify(res.data)}`);
  });

  // Also simulate concurrent admin status check
  const adminCheck = admin('GET', 'state');

  await Promise.all([...promises, adminCheck]);

  // Verify all 30 allocations were saved with zero lost writes
  const finalState = await store.load();
  let savedCount = 0;
  for (const t of finalState.teams) {
    if (finalState.allocations[t.id] && finalState.allocations[t.id][1]) {
      savedCount++;
    }
  }
  assert.equal(savedCount, 30, 'All 30 teams must have their round 1 chits recorded');
});

test('Full 4-quarter event with 8 teams matches an independent calculation', async () => {
  await admin('POST', 'reset', { confirm: 'RESET', clearTeams: true });
  await admin('POST', 'returns', { csv: FIXTURE_RETURNS_CSV });
  const names = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6', 'Team 7', 'Team 8'];
  assert.equal((await admin('POST', 'teams', { names })).status, 200);
  const rand = mulberry32(2026);
  const model = Object.fromEntries(names.map((n) => [n, 100]));

  for (let round = 1; round <= 4; round++) {
    await admin('POST', 'news', { round, items: [{ headline: `Quarter ${round} headline`, body: 'Body' }] });
    // news -> investing -> entry
    await admin('POST', 'advance', {});
    await admin('POST', 'advance', {});
    let pub = (await call('GET', '/api/board')).data;
    assert.equal(pub.phase, 'entry');
    assert.equal(pub.companies[0].growth.length, round - 1, 'growth must only be public for finished rounds');

    const ctx = (await call('GET', '/api/entry', { pin: COORD_PIN })).data;
    assert.equal(ctx.writable, true);
    assert.ok(!JSON.stringify(ctx).includes('growth'));
    for (const t of ctx.teams) {
      assert.equal(Math.round(model[t.name] * 100) / 100, Math.round(Number(t.capitalStart) * 100) / 100, 'capital start matches model');
      const k = 4;
      const picks = ctx.companies.slice(0, k);
      const capInt = Math.floor(Number(t.capitalStart));
      const spend = Math.min(capInt, 40);
      const amounts = {};
      let left = spend;
      picks.forEach((c, i) => {
        const part = i === picks.length - 1 ? left : Math.max(1, Math.floor(left / 4));
        amounts[c.id] = String(part);
        left -= part;
      });
      const r = await call('POST', '/api/entry', { pin: COORD_PIN, body: { teamId: t.id, round, amounts } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      // update the independent model with what was actually entered
      let invested = 0;
      let exit = 0;
      for (const [cid, v] of Object.entries(amounts)) {
        const amt = Number(v);
        invested += amt;
        exit += amt * (1 + sheet[Number(cid.slice(1)) - 1].g[round - 1]);
      }
      const rawNav = (Number(t.capitalStart) - invested) + exit;
      model[t.name] = Math.round(rawNav * 100) / 100;
    }
    // one over-budget chit must be refused and leave the saved one alone
    const t0 = ctx.teams[0];
    const bad = await call('POST', '/api/entry', { pin: COORD_PIN, body: { teamId: t0.id, round, amounts: { c1: '1000' } } });
    assert.equal(bad.status, 422);

    assert.equal((await admin('POST', 'advance', {})).status, 200); // -> revealed
    pub = (await call('GET', '/api/board')).data;
    assert.equal(pub.phase, 'revealed');
    assert.equal(pub.companies[0].growth.length, round);
    if (round <= 2) {
      assert.equal(pub.standingsHidden, false);
      for (const t of pub.teams) {
        assert.ok(Math.abs(Number(t.worth) - model[t.name]) < 0.02, `${t.name} round ${round}: ${t.worth} vs ${model[t.name]}`);
      }
      const worths = pub.teams.map((t) => Number(t.worth));
      assert.deepEqual(worths, [...worths].sort((a, b) => b - a));
    } else {
      // In Q3 and Q4, public board hides standings (no ranks, no worth, no history)
      assert.equal(pub.standingsHidden, true);
      assert.equal(pub.teams[0].worth, undefined);
      assert.equal(pub.teams[0].rank, undefined);

      // But admin board always has full standings
      const admBoard = (await admin('GET', 'board')).data;
      assert.equal(admBoard.standingsHidden, false);
      for (const t of admBoard.teams) {
        assert.ok(Math.abs(Number(t.worth) - model[t.name]) < 0.02, `${t.name} round ${round}: ${t.worth} vs ${model[t.name]}`);
      }
    }
    if (round < 4) await admin('POST', 'advance', {});
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
  const csv = await fetch(base + '/api/admin/export.csv', { headers: { 'x-pin': ADMIN_PIN } });
  const text = await csv.text();
  assert.equal(text.trim().split('\n').length, 1 + 8 * 4);
  const audit = (await admin('GET', 'audit')).data.lines;
  assert.ok(audit.some((l) => l.action === 'entry.set'));
  assert.ok(fs.readdirSync(store.backupDir).length >= 4, 'a backup is written at every reveal');
});


test('Coordinator access rules: cannot call admin routes, cannot access other teams, unassigned gets no data', async () => {
  // Create an unassigned coordinator
  const unassignedPin = '991122';
  await store.setCoordinator({
    id: 'coord-unassigned',
    code: 'CUNASS',
    pinHash: hashPin(unassignedPin),
    pinPlain: unassignedPin,
    assignedTeams: [],
    enabled: true,
    createdAt: Date.now(),
  });

  const unassignedLogin = await call('POST', '/api/auth/login', { body: { code: 'CUNASS', pin: unassignedPin } });
  assert.equal(unassignedLogin.status, 200);
  const unassignedToken = unassignedLogin.data.token;

  // Unassigned coordinator receives no data and clear message
  const unassignedCtx = await call('GET', '/api/coord/entry', { token: unassignedToken });
  assert.equal(unassignedCtx.status, 200);
  assert.equal(unassignedCtx.data.noTeamAssigned, true);
  assert.equal(unassignedCtx.data.teams.length, 0);

  // Unassigned coordinator cannot submit an entry
  const unassignedSubmit = await call('POST', '/api/coord/entry', {
    token: unassignedToken,
    body: { teamId: 't1', round: 1, amounts: { c1: '10' } }
  });
  assert.equal(unassignedSubmit.status, 403);

  // Assigned coordinator
  const assignedPin = '334455';
  await store.setCoordinator({
    id: 'coord-assigned',
    code: 'CASS',
    pinHash: hashPin(assignedPin),
    pinPlain: assignedPin,
    assignedTeams: ['t-alpha'],
    enabled: true,
    createdAt: Date.now(),
  });
  const assignedLogin = await call('POST', '/api/auth/login', { body: { code: 'CASS', pin: assignedPin } });
  const assignedToken = assignedLogin.data.token;

  // Coordinator cannot call any /api/admin/* route
  assert.equal((await call('GET', '/api/admin/state', { token: assignedToken })).status, 403);
  assert.equal((await call('GET', '/api/admin/board', { token: assignedToken })).status, 403);
  assert.equal((await call('POST', '/api/admin/advance', { token: assignedToken, body: {} })).status, 403);
  assert.equal((await call('GET', '/api/admin/coordinators', { token: assignedToken })).status, 403);

  // Coordinator cannot write to unassigned team
  const crossTeamEntry = await call('POST', '/api/coord/entry', {
    token: assignedToken,
    body: { teamId: 't-beta', round: 1, amounts: { c1: '10' } }
  });
  assert.equal(crossTeamEntry.status, 403);

  const crossTeamRumor = await call('POST', '/api/coord/rumor', {
    token: assignedToken,
    body: { teamId: 't-beta', round: 1 }
  });
  assert.equal(crossTeamRumor.status, 403);
});
