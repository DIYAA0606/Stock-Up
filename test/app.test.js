import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import * as app from '../src/app.js';

const APEX = 'c1';
const NEXUS = 'c6';
const QUANTUM = 'c7';

function fresh(teams = ['Alpha', 'Beta', 'Gamma']) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'gtg-test-')));
  app.addTeams(store.state, teams);
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
const enter = (st, team, round, amounts, role = 'coordinator') => app.applyEntry(st, { teamId: id(st, team), round, amounts, role });
const board = (st) => app.buildBoard(st);
const worthOf = (st, name) => board(st).teams.find((t) => t.name === name).worth;

test('starts at Round 1 information release with everyone on starting capital and no growth visible', () => {
  const st = fresh();
  const b = board(st);
  assert.equal(b.round, 1);
  assert.equal(b.label, 'Company Information Release');
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
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: '60', [NEXUS]: '45' }), (e) => e.status === 422 && /105 Cr but only 100 Cr/.test(e.message));
  assert.equal(st.allocations[id(st, 'Alpha')], undefined);
});

test('exactly the available capital is fine; there is no per-company cap and no minimum enforced', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  assert.doesNotThrow(() => enter(st, 'Alpha', 1, { [APEX]: '100' }));
});

test('negative or junk amounts are rejected', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: '-5' }), /negative/i);
  assert.throws(() => enter(st, 'Alpha', 1, { [APEX]: 'abc' }), /Invalid number/);
  assert.throws(() => enter(st, 'Alpha', 1, { nope: '5' }), /Unknown company/);
});

test('results stay hidden until the reveal step, then worth updates', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '50', [NEXUS]: '50' }); // +18% and +17% -> 59 + 58.5
  enter(st, 'Beta', 1, {}); // all cash
  enter(st, 'Gamma', 1, { [APEX]: '100' });
  let b = board(st);
  assert.ok(b.teams.every((t) => t.worth === '100'), 'worth must not change before reveal');
  assert.ok(b.companies.every((c) => c.growth.length === 0), 'growth must not be sent before reveal');
  app.advance(st); // -> revealed
  b = board(st);
  assert.equal(b.label, 'Quarter 1 Results');
  assert.equal(worthOf(st, 'Alpha'), '117.5');
  assert.equal(worthOf(st, 'Beta'), '100');
  assert.equal(worthOf(st, 'Gamma'), '118');
  assert.deepEqual(b.teams.map((t) => t.name), ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(b.teams.map((t) => t.rank), [1, 2, 3]);
  assert.equal(b.companies.find((c) => c.id === APEX).growth.length, 1);
});

test('advancing past the capital-update step warns about missing chits unless forced', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '10' });
  assert.throws(() => app.advance(st), (e) => e.status === 409 && e.extra.missing.length === 2);
  app.advance(st, { force: true });
  assert.equal(worthOf(st, 'Beta'), '100'); // no chit = all cash
});

test('capital rolls over: round 2 starts from round 1 exit value, and rank change is reported', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' }); // 118
  enter(st, 'Beta', 1, { [NEXUS]: '100' }); // 117
  enter(st, 'Gamma', 1, {}); // 100
  app.advance(st);
  goTo(st, 2, 'investing');
  const ctx = app.entryContext(st, 'coordinator');
  assert.equal(ctx.teams.find((t) => t.name === 'Alpha').capitalStart, '118');
  assert.equal(ctx.teams.find((t) => t.name === 'Gamma').capitalStart, '100');
  goTo(st, 2, 'entry');
  enter(st, 'Alpha', 2, { [NEXUS]: '118' }); // Nexus Q2 = -6% -> 110.92
  enter(st, 'Beta', 2, { [QUANTUM]: '117' }); // Quantum Q2 = +9% -> 127.53
  enter(st, 'Gamma', 2, {});
  app.advance(st);
  const b = board(st);
  assert.deepEqual(b.teams.map((t) => [t.name, t.worth, t.rank, t.change]), [
    ['Beta', '127.53', 1, 1],
    ['Alpha', '110.92', 2, -1],
    ['Gamma', '100', 3, 0],
  ]);
});

test('correcting an earlier chit that would break a later chit is refused, with a clear message', () => {
  const st = fresh(['Alpha']);
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' }); // ends 118
  app.advance(st);
  goTo(st, 2, 'entry');
  enter(st, 'Alpha', 2, { [QUANTUM]: '118' });
  // admin tries to shrink round 1 exposure: end value would be 109, round 2 needs 118
  assert.throws(
    () => enter(st, 'Alpha', 1, { [APEX]: '50' }, 'admin'),
    (e) => e.status === 422 && /round 2/.test(e.message),
  );
  // original chit is untouched
  assert.deepEqual(st.allocations[id(st, 'Alpha')][1].amounts, { [APEX]: '100' });
});

test('a valid correction recalculates everything downstream', () => {
  const st = fresh(['Alpha']);
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' });
  app.advance(st);
  goTo(st, 2, 'entry');
  enter(st, 'Alpha', 2, { [QUANTUM]: '100' }); // 100*1.09 + 18 cash = 127
  app.advance(st);
  assert.equal(worthOf(st, 'Alpha'), '127');
  enter(st, 'Alpha', 1, { [NEXUS]: '100' }, 'admin'); // now 117 after Q1 -> Q2: 100*1.09 + 17
  assert.equal(worthOf(st, 'Alpha'), '126');
});

test('going back hides results again', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' });
  app.advance(st, { force: true });
  assert.equal(worthOf(st, 'Alpha'), '118');
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
  assert.ok(!ctx.includes('0.18'));
});

test('final results are revealed from last place upward, one step at a time', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' });
  enter(st, 'Beta', 1, { [NEXUS]: '100' });
  app.advance(st, { force: true });
  goTo(st, 6, 'revealed');
  app.advance(st, { force: true });
  assert.equal(board(st).phase, 'final');
  assert.deepEqual(board(st).teams.map((t) => !!t.hidden), [true, true, true]);
  app.finalReveal(st, 'next');
  assert.deepEqual(board(st).teams.map((t) => !!t.hidden), [true, true, false]);
  assert.equal(board(st).teams[2].name, 'Gamma');
  app.finalReveal(st, 'all');
  assert.deepEqual(board(st).teams.map((t) => t.name), ['Alpha', 'Beta', 'Gamma']);
  assert.throws(() => app.advance(st), /final/);
});

test('timeline has 4 steps per round plus the final: 25 steps for 6 rounds', () => {
  assert.equal(app.steps(6).length, 25);
});

test('growth data cannot be changed to drop a company that already has money in it', () => {
  const st = fresh();
  goTo(st, 1, 'investing');
  enter(st, 'Alpha', 1, { [APEX]: '10' });
  const csv = ['Company\tQ1\tQ2\tQ3\tQ4\tQ5\tQ6', 'Nexus Bank\t0.1\t0.1\t0.1\t0.1\t0.1\t0.1'].join('\n');
  assert.throws(() => app.setReturns(st, csv), /Cannot remove "ApexTech Systems"/);
});

test('reset clears chits and goes back to the start, keeping teams', () => {
  const st = fresh();
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '100' });
  app.advance(st, { force: true });
  app.resetEvent(st);
  assert.equal(st.step, 0);
  assert.deepEqual(st.allocations, {});
  assert.equal(st.teams.length, 3);
  app.resetEvent(st, { clearTeams: true });
  assert.equal(st.teams.length, 0);
});

test('CSV export contains one row per team per entered round', () => {
  const st = fresh(['Alpha']);
  goTo(st, 1, 'entry');
  enter(st, 'Alpha', 1, { [APEX]: '40', [NEXUS]: '60' });
  app.advance(st);
  const lines = app.exportCsv(st).split('\n');
  assert.match(lines[0], /^Team,Round,CapitalStart,Invested,Cash,ExitTotal,CapitalEnd,Invested:ApexTech Systems/);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^Alpha,1,100,100,0,117\.4,117\.4,40,/);
});
