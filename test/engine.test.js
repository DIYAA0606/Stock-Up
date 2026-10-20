import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUnits, fromUnits, parseGrowth, buildReturns, computeTeam, rankItems, parseReturnsCsv } from '../src/engine.js';
import { SEED_CSV } from '../src/seed.js';

const U = toUnits;

test('growth parsing: plain numbers are fractions, % cells are percentages', () => {
  assert.equal(fromUnits(parseGrowth('0.18')), '0.18');
  assert.equal(fromUnits(parseGrowth('0.084')), '0.084');
  assert.equal(fromUnits(parseGrowth('-6.00%')), '-0.06');
  assert.equal(fromUnits(parseGrowth('-6.30%')), '-0.063');
  assert.equal(fromUnits(parseGrowth('-100.00%')), '-1');
});

test('growth below -100% is clamped (a position cannot go negative)', () => {
  assert.equal(fromUnits(parseGrowth('-150%')), '-1');
  assert.equal(fromUnits(parseGrowth('-2')), '-1');
});

test('seed sheet: 12 companies x 6 quarters, matches the screenshot', () => {
  const cos = parseReturnsCsv(SEED_CSV, 6);
  assert.equal(cos.length, 12);
  assert.ok(cos.every((c) => c.returns.length === 6));
  const by = Object.fromEntries(cos.map((c) => [c.name, c.returns]));
  assert.deepEqual(by['ApexTech Systems'], ['0.18', '0.14', '0.12', '0.1', '-0.06', '-1']);
  assert.deepEqual(by['CineVerse Studios'], ['-0.063', '0.05', '0.11', '0.06', '-0.03', '0.12']);
  assert.deepEqual(by['OceanWave Logistics'], ['0.028', '-0.05', '0.1', '-0.07', '0.18', '0.09']);
  assert.deepEqual(by['CyberShield Solutions'], ['0.116', '0.13', '0.08', '0.14', '0.05', '0.16']);
});

test('CSV import reports readable errors', () => {
  assert.throws(() => parseReturnsCsv('Company\tQ1\nA\t0.1', 6), /Header must be/);
  assert.throws(() => parseReturnsCsv('Company,Q1\nA,abc', 1), /Row 2 \(A\), Q1: cannot read "abc"/);
  assert.throws(() => parseReturnsCsv('Company,Q1\nA,0.1\na,0.2', 1), /duplicate/);
});

const seeded = () => {
  const companies = parseReturnsCsv(SEED_CSV, 6).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  return { companies, returns: buildReturns(companies, 6), id: Object.fromEntries(companies.map((c) => [c.name, c.id])) };
};

test('worked example: round 1 and round 2 roll the whole portfolio forward', () => {
  const { returns, id } = seeded();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 6,
    returns,
    upTo: 2,
    allocations: {
      1: { [id['ApexTech Systems']]: '30', [id['Nexus Bank']]: '25', [id['SkyLink Aerospace']]: '25', [id['CineVerse Studios']]: '20' },
      2: { [id['ApexTech Systems']]: '50', [id['QuantumChip Technologies']]: '40' },
    },
  });
  // Q1: 30*1.18 + 25*1.17 + 25*0.99 + 20*0.937 = 35.4 + 29.25 + 24.75 + 18.74 = 108.14
  assert.equal(fromUnits(r.rounds[0].capitalEnd), '108.14');
  // Q2 starts with 108.14: 50 and 40 invested, 18.14 stays as cash. 50*1.14 + 40*1.09 + 18.14 = 57 + 43.6 + 18.14
  assert.equal(fromUnits(r.rounds[1].capitalStart), '108.14');
  assert.equal(fromUnits(r.rounds[1].cash), '18.14');
  assert.equal(fromUnits(r.rounds[1].capitalEnd), '118.74');
  assert.equal(fromUnits(r.worth), '118.74');
});

test('ApexTech Q6 is a total wipeout and cash is untouched', () => {
  const { returns, id } = seeded();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 6,
    returns,
    upTo: 6,
    allocations: { 6: { [id['ApexTech Systems']]: '60', [id['CyberShield Solutions']]: '10' } },
  });
  // Rounds 1-5 invest nothing (cash flat at 100). Q6: 60 -> 0, 10 * 1.16 = 11.6, cash 30
  assert.equal(fromUnits(r.rounds[5].exitTotal), '11.6');
  assert.equal(fromUnits(r.worth), '41.6');
});

test('nothing invested means worth stays at starting capital', () => {
  const { returns } = seeded();
  const r = computeTeam({ startingCapital: U(100), rounds: 6, returns, upTo: 6, allocations: {} });
  assert.equal(fromUnits(r.worth), '100');
});

test('only rounds up to `upTo` are computed (later results never leak into worth)', () => {
  const { returns, id } = seeded();
  const allocations = { 1: { [id['ApexTech Systems']]: '100' }, 2: { [id['ApexTech Systems']]: '114' } };
  const r = computeTeam({ startingCapital: U(100), rounds: 6, returns, upTo: 1, allocations });
  assert.equal(fromUnits(r.worth), '118');
  assert.equal(r.rounds[1].capitalEnd, null);
});

test('over-budget is flagged per round', () => {
  const { returns, id } = seeded();
  const r = computeTeam({ startingCapital: U(100), rounds: 6, returns, upTo: 1, allocations: { 1: { [id['Nexus Bank']]: '60', [id['Nexus Bank'] === 'c6' ? 'c7' : 'c6']: '50' } } });
  assert.equal(r.rounds[0].overBudget, true);
});

test('exact arithmetic: no floating point drift over six compounding rounds', () => {
  const { returns, id } = seeded();
  // All-in on one company each round, reinvesting everything.
  const picks = ['ApexTech Systems', 'ApexTech Systems', 'ApexTech Systems', 'ApexTech Systems', 'TerraGrid Energy', 'CyberShield Solutions'];
  const allocations = {};
  // Build progressively because each round's stake depends on the previous exit.
  let cap = U(100);
  for (let r = 1; r <= 6; r++) {
    allocations[r] = { [id[picks[r - 1]]]: fromUnits(cap) };
    const step = computeTeam({ startingCapital: U(100), rounds: 6, returns, upTo: r, allocations });
    cap = step.worth;
  }
  // 100 * 1.18 * 1.14 * 1.12 * 1.10 * 1.16 * 1.16  (each step truncated at 6 dp, so compare to 3 dp)
  const expected = 100 * 1.18 * 1.14 * 1.12 * 1.1 * 1.16 * 1.16;
  assert.ok(Math.abs(Number(fromUnits(cap)) - expected) < 0.001, `${fromUnits(cap)} vs ${expected}`);
});

test('ranking: highest worth first, equal worth shares a rank (no tie-break)', () => {
  const m = rankItems([
    { id: 'a', worth: U(110) },
    { id: 'b', worth: U(120) },
    { id: 'c', worth: U(110) },
    { id: 'd', worth: U(90) },
  ]);
  assert.equal(m.get('b'), 1);
  assert.equal(m.get('a'), 2);
  assert.equal(m.get('c'), 2);
  assert.equal(m.get('d'), 4);
});
