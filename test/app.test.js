import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import * as app from '../src/app.js';

// Stock IDs in 10-stock matrix
const APEX = 'c1';      // ApexTech (+18% Q1)
const MEDHEAL = 'c2';   // MedHeal (-3% Q1)
const GREENFUEL = 'c3'; // GreenFuel (+4.5% Q1)
const QUICKMART = 'c5'; // QuickMart (+9.1% Q1)
const FINBANK = 'c7';   // FinBank (+17% Q1)

function fresh(teams = ['Alpha', 'Beta', 'Gamma'], { penaltyMode = 'every_quarter' } = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'gtg-test-')));
  app.addTeams(store.state, teams);
  store.state.settings.penaltyMode = penaltyMode;
  return store.state;
}
const id = (st, name) => st.teams.find((t) => t.name === name).id;
function goTo(st, round, phase) {
  for (let i = 0; i < 100; i++) {
    const c = app.current(st);
    if (c.round === round && c.phase === phase) return;
    app.advance(st, { force: true });
  }
  throw new Error('could not reach ' + round + phase);
}
const enter = (st, team, round, amounts, role = 'coordinator') =>
  app.applyEntry(st, { teamId: id(st, team), round, amounts, role });
const board = (st) => app.buildBoard(st);
const worthOf = (st, name) => board(st).teams.find((t) => t.name === name).worth;

test('starts at Quarter 1 information release with everyone on starting capital and no growth visible', () => {
  const st = fresh();
  const b = board(st);
  assert.equal(b.round, 1);
  assert.equal(b.rounds, 4);
  assert.equal(b.entryOpen, false);
  assert.ok(b.teams.every((t) => t.worth === '100'));
  assert.ok(b.companies.every((c) => c.growth.length === 0));
});

test('entry is closed outside the investment/capital-update phases for coordinators, admin can still enter', () => {
  const st = fresh();
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: '10' }), /closed/);
  assert.doesNotThrow(() => enter(st, 'Alpha', 1, { [APEX]: '10' }, 'admin'));
});

test('nobody can enter a round that has not started', () => {
  const st = fresh();
  assert.throws(() => enter(st, 'Alpha', 2, { [APEX]: '10' }, 'admin'), /not started/);
});

test('total investment above available capital is rejected and nothing is saved', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: '60', [FINBANK]: '45' }), (e) => e.status === 422 && /105 Cr but only 100 Cr/.test(e.message));
  assert.equal(st.allocations[id(st, 'Alpha')], undefined);
});

test('allocation of 0.5 is rejected and exactly 1 is accepted', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: '0.5' }), (e) => e.status === 400 && /at least 1 Cr/.test(e.message));
  assert.doesNotThrow(() => enter(st, 'Alpha', 1, { [APEX]: '1' }));
});

test('negative or junk amounts are rejected', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: '-5' }), /negative/i);
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: 'abc' }), /Invalid number/);
  assert.throws(() => enter(st, 'Alpha', 1, { nope: '5' }), /Unknown company/);
});

test('rumor purchase immediately deducts 5 Cr and updates investable cash', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  const res = app.buyRumor(st, { teamId: id(st, 'Alpha'), round: 1, role: 'coordinator' });
  assert.equal(res.rumorCount, 1);
  assert.equal(res.rumorFees, '5');
  assert.equal(res.investableCash, '95');

  // Now max investable is 95 Cr: investing 96 Cr must be rejected
  assert.throws(
    () => enter(st, 'Alpha', 1, { [APEX]: '96' }),
    (e) => e.status === 422 && /only 95 Cr is investable/.test(e.message)
  );
  // Investing 95 Cr is allowed
  assert.doesNotThrow(() => enter(st, 'Alpha', 1, { [APEX]: '95' }));
});

test('rumor purchase rejected when it would exceed available cash with existing allocations', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  // Team invests 98 Cr (leaving 2 Cr)
  enter(st, 'Alpha', 1, { [APEX]: '98' });
  // Buying rumor costs 5 Cr; 98 + 5 = 103 > 100 -> rejected
  assert.throws(
    () => app.buyRumor(st, { teamId: id(st, 'Alpha'), round: 1, role: 'coordinator' }),
    (e) => e.status === 422 && /would exceed capital/.test(e.message)
  );
});

test('coordinator cannot decrease rumor count; only admin can adjust', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  app.buyRumor(st, { teamId: id(st, 'Alpha'), round: 1, role: 'coordinator' });
  app.buyRumor(st, { teamId: id(st, 'Alpha'), round: 1, role: 'coordinator' });
  assert.equal(st.rumors[id(st, 'Alpha')][1], 2);

  // Admin can adjust rumors to 1
  const adj = app.adjustRumors(st, { teamId: id(st, 'Alpha'), round: 1, count: 1 });
  assert.equal(adj.before, 2);
  assert.equal(adj.after, 1);
  assert.equal(st.rumors[id(st, 'Alpha')][1], 1);
});

test('results stay hidden until the reveal step, then worth updates with 4-stock penalty rules', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  // Alpha: 4 distinct stocks -> 25 each in Apex (18%), MedHeal (-3%), QuickMart (9.1%), FinBank (17%)
  // 25*(1.18 + 0.97 + 1.091 + 1.17) = 110.275 -> rounded half-up to 110.28
  enter(st, 'Alpha', 1, { [APEX]: '25', [MEDHEAL]: '25', [QUICKMART]: '25', [FINBANK]: '25' });
  enter(st, 'Beta', 1, {}); // all cash -> 100 - 15% penalty = 85
  // Gamma: 1 stock -> 100 in Apex (118) - 15% penalty = 118 * 0.85 = 100.3
  enter(st, 'Gamma', 1, { [APEX]: '100' });

  let b = board(st);
  assert.ok(b.teams.every((t) => t.worth === '100'), 'worth must not change before reveal');
  assert.ok(b.companies.every((c) => c.growth.length === 0), 'growth must not be sent before reveal');

  app.advance(st); // -> revealed
  b = board(st);
  assert.equal(worthOf(st, 'Alpha'), '110.28');
  assert.equal(worthOf(st, 'Beta'), '85');
  assert.equal(worthOf(st, 'Gamma'), '100.3');
  assert.deepEqual(b.teams.map((t) => t.name), ['Alpha', 'Gamma', 'Beta']);
  assert.deepEqual(b.teams.map((t) => t.rank), [1, 2, 3]);
  assert.equal(b.companies.find((c) => c.id === APEX).growth.length, 1);
});

test('advancing past capital-update warns about missing chits unless forced', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '10' });
  assert.throws(() => app.advance(st), (e) => e.status === 409 && e.extra.missing.length === 2);
  app.advance(st, { force: true });
  assert.equal(worthOf(st, 'Beta'), '85'); // unentered = all cash, penalized 15% -> 85
});

test('capital rolls over: round 2 starts from round 1 closing NAV (after penalty)', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  // Alpha has 4 stocks -> 110.28
  enter(st, 'Alpha', 1, { [APEX]: '25', [MEDHEAL]: '25', [QUICKMART]: '25', [FINBANK]: '25' });
  enter(st, 'Gamma', 1, { [APEX]: '100' }); // 100.3
  app.advance(st, { force: true }); // revealed

  goTo(st, 2, 'investing');
  const ctx = app.entryContext(st, 'coordinator');
  assert.equal(ctx.teams.find((t) => t.name === 'Alpha').capitalStart, '110.28');
  assert.equal(ctx.teams.find((t) => t.name === 'Gamma').capitalStart, '100.3');
});

test('correcting an earlier chit that would break a later chit is refused', () => {
  const st = fresh(['Alpha']);
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' }); // 118 * 0.85 = 100.3
  app.advance(st);
  goTo(st, 2, 'entry');
  enter(st, 'Alpha', 2, { [GREENFUEL]: '100' });

  // admin tries to change Q1 to MedHeal (-3%): 100 * 0.97 * 0.85 = 82.45, but Q2 needs 100
  assert.throws(
    () => enter(st, 'Alpha', 1, { [MEDHEAL]: '100' }, 'admin'),
    (e) => e.status === 422 && /round 2/.test(e.message)
  );
});

test('going back hides results again', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '25', [MEDHEAL]: '25', [QUICKMART]: '25', [FINBANK]: '25' });
  app.advance(st, { force: true });
  assert.equal(worthOf(st, 'Alpha'), '110.28');
  app.back(st);
  assert.equal(worthOf(st, 'Alpha'), '100');
  assert.ok(board(st).companies.every((c) => c.growth.length === 0));
});

test('the coordinator view never contains growth figures', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  app.advance(st, { force: true });
  goTo(st, 2, 'investing');
  const ctx = JSON.stringify(app.entryContext(st, 'coordinator'));
  assert.ok(!/growth|returns/i.test(ctx));
  assert.ok(!ctx.includes('0.18') && !ctx.includes('18%'));
});

test('final results are revealed from last place upward, one step at a time', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '25', [MEDHEAL]: '25', [QUICKMART]: '25', [FINBANK]: '25' });
  enter(st, 'Beta', 1, { [APEX]: '100' });
  app.advance(st, { force: true });
  goTo(st, 4, 'revealed');
  app.advance(st, { force: true }); // final
  assert.equal(board(st).phase, 'final');
  assert.deepEqual(board(st).teams.map((t) => !!t.hidden), [true, true, true]);
  app.finalReveal(st, 'next');
  assert.deepEqual(board(st).teams.map((t) => !!t.hidden), [true, true, false]);
  app.finalReveal(st, 'all');
  assert.deepEqual(board(st).teams.map((t) => t.name), ['Alpha', 'Beta', 'Gamma']);
  assert.throws(() => app.advance(st), /final/);
});

test('timeline has 4 steps per round plus the final: 17 steps for 4 rounds', () => {
  assert.equal(app.steps(4).length, 17);
});

test('reset clears chits, rumors and goes back to start, keeping teams', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '25' });
  app.buyRumor(st, { teamId: id(st, 'Alpha'), round: 1, role: 'admin' });
  app.advance(st, { force: true });
  app.resetEvent(st);
  assert.equal(st.step, 0);
  assert.deepEqual(st.allocations, {});
  assert.deepEqual(st.rumors, {});
  assert.equal(st.teams.length, 3);
});

test('CSV export contains exact required columns', () => {
  const st = fresh(['Alpha']);
  goTo(st, 1, 'entry');
  app.buyRumor(st, { teamId: id(st, 'Alpha'), round: 1, role: 'admin' });
  enter(st, 'Alpha', 1, { [APEX]: '25', [MEDHEAL]: '25', [QUICKMART]: '25', [FINBANK]: '20' });
  app.advance(st);
  const csv = app.exportCsv(st);
  const lines = csv.split('\n');
  assert.match(lines[0], /^Team,Coordinator,Quarter,RumorCount,RumorFees,Allocation:ApexTech/);
  assert.match(lines[1], /^Alpha,Unassigned,1,1,5,/);
});

