import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toUnits,
  fromUnits,
  roundHalfUp,
  parseGrowth,
  buildReturns,
  computeTeam,
  rankItems,
  parseReturnsCsv,
  SCALE,
} from '../src/engine.js';
import { loadReturnsCsv } from '../src/seed.js';

const U = toUnits;

// Independent 10-stock x 3-quarter test fixture (so changes to config/returns.csv never break engine tests)
const FIXTURE_CSV = `Stock,Q1,Q2,Q3
ApexTech,-4.5,10,-20
MedHeal,-3,4.2,-3.5
GreenFuel,18.4,5.5,-9
UrbanNest,6.3,-6.8,-17
QuickMart,9.1,6,-4
Velocity,15,-7.5,-16
FinBank,1.5,2.5,-42
AgriGrow,15.2,-5.2,-10
Astra Motors,8.4,-8,-18
SkyLink,-1,-4,-15`;

function fixtureSetup() {
  const companies = parseReturnsCsv(FIXTURE_CSV, 3).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  return {
    companies,
    returns: buildReturns(companies, 3),
    id: Object.fromEntries(companies.map((c) => [c.name, c.id])),
  };
}

test('growth parsing: percent numbers and % cells parse to scaled integers', () => {
  assert.equal(parseGrowth('18'), 180_000n);
  assert.equal(parseGrowth('4.2'), 42_000n);
  assert.equal(parseGrowth('-45'), -450_000n);
  assert.equal(parseGrowth('-6%'), -60_000n);
  assert.equal(parseGrowth('+18.4%'), 184_000n);
  assert.equal(parseGrowth('-100%'), -1_000_000n);
  assert.equal(parseGrowth('0'), 0n);
  assert.equal(parseGrowth(''), 0n);
});

test('growth below -100% is clamped (a position cannot go negative)', () => {
  assert.equal(parseGrowth('-150%'), -SCALE);
  assert.equal(parseGrowth('-200'), -SCALE);
});

test('config/returns.csv has exactly 10 stocks x 3 quarters with no missing cells', () => {
  const raw = loadReturnsCsv();
  const cos = parseReturnsCsv(raw, 3);
  assert.equal(cos.length, 10, 'Must have exactly 10 stocks');
  assert.ok(cos.every((c) => c.returns.length === 3), 'Each stock must have 3 quarters');
  assert.equal(cos.warnings.length, 0, `Expected 0 warnings but got: ${cos.warnings.join(', ')}`);
});

test('CSV import reports readable errors and handles blanks', () => {
  assert.throws(() => parseReturnsCsv('Stock,Q1,Q2,Q3,Q4\nA,10,20,30,40', 3), /Header must be/);
  assert.throws(() => parseReturnsCsv('Stock,Q1\nA,abc', 1), /cannot read "abc"/);
  assert.throws(() => parseReturnsCsv('Stock,Q1\nA,10\na,20', 1), /duplicate/);

  // Missing or blank cells default to 0 with a warning
  const withBlank = parseReturnsCsv('Stock,Q1,Q2\nStockA,10,\nStockB,,5', 2);
  assert.equal(withBlank.length, 2);
  assert.deepEqual(withBlank[0].returns, ['10', '0']);
  assert.deepEqual(withBlank[1].returns, ['0', '5']);
  assert.equal(withBlank.warnings.length, 2);
});

test('Case A: start 100, 2 rumors (fee 10), ApexTech 20, GreenFuel 30, QuickMart 10, FinBank 10 -> NAV 95.68, no penalty', () => {
  const { returns, id } = fixtureSetup();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 3,
    returns,
    upTo: 1,
    rumorFee: 5,
    rumors: { 1: 2 }, // 2 rumors = 10 Cr
    allocations: {
      1: {
        [id['ApexTech']]: '20',
        [id['GreenFuel']]: '30',
        [id['QuickMart']]: '10',
        [id['FinBank']]: '10',
      },
    },
    penaltyMode: 'every_quarter',
  });

  const q1 = r.rounds[0];
  assert.equal(fromUnits(q1.capitalStart), '100');
  assert.equal(q1.rumorCount, 2);
  assert.equal(fromUnits(q1.rumorFees), '10');
  assert.equal(fromUnits(q1.investableCash), '90');
  assert.equal(fromUnits(q1.invested), '70');
  assert.equal(fromUnits(q1.cash), '20');
  assert.equal(q1.distinctCount, 4);
  assert.equal(q1.penalized, false);
  assert.equal(fromUnits(q1.penalty), '0');
  assert.equal(fromUnits(q1.capitalEnd), '95.68');
  assert.equal(fromUnits(r.worth), '95.68');
});

test('Case B: start 100, no rumors, GreenFuel 50, AgriGrow 30, QuickMart 20 -> pre-penalty 115.58, penalty 15%, NAV 98.24', () => {
  const { returns, id } = fixtureSetup();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 3,
    returns,
    upTo: 1,
    rumors: {},
    allocations: {
      1: {
        [id['GreenFuel']]: '50',
        [id['AgriGrow']]: '30',
        [id['QuickMart']]: '20',
      },
    },
    penaltyMode: 'every_quarter',
  });

  const q1 = r.rounds[0];
  assert.equal(q1.distinctCount, 3);
  assert.equal(q1.penalized, true);
  assert.equal(fromUnits(q1.navBeforePenalty), '115.58');
  assert.equal(fromUnits(q1.penalty), '17.337');
  assert.equal(fromUnits(q1.capitalEnd), '98.24');
  assert.equal(fromUnits(r.worth), '98.24');
});

test('Case C (uses config/returns.csv): ApexTech 25, MedHeal 25, QuickMart 25, FinBank 25 in Q1 -> exact NAV 110.275, stored as 110.28', () => {
  const csv = loadReturnsCsv();
  const companies = parseReturnsCsv(csv, 3).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  const returns = buildReturns(companies, 3);
  const id = Object.fromEntries(companies.map((c) => [c.name, c.id]));

  const r = computeTeam({
    startingCapital: U(100),
    rounds: 3,
    returns,
    upTo: 1,
    allocations: {
      1: {
        [id['ApexTech']]: '25',
        [id['MedHeal']]: '25',
        [id['QuickMart']]: '25',
        [id['FinBank']]: '25',
      },
    },
    penaltyMode: 'every_quarter',
  });

  const q1 = r.rounds[0];
  assert.equal(q1.distinctCount, 4);
  assert.equal(q1.penalized, false);
  assert.equal(fromUnits(q1.navBeforePenalty), '110.275');
  assert.equal(fromUnits(q1.capitalEnd), '110.28');
  assert.equal(fromUnits(r.worth), '110.28');
});

test('allocation of 0.5 is rejected and exactly 1 is accepted', () => {
  const { returns, id } = fixtureSetup();
  assert.throws(
    () =>
      computeTeam({
        startingCapital: U(100),
        rounds: 3,
        returns,
        upTo: 1,
        minPerStock: 1,
        allocations: { 1: { [id['ApexTech']]: '0.5' } },
      }),
    /below minimum/
  );

  assert.doesNotThrow(() =>
    computeTeam({
      startingCapital: U(100),
      rounds: 3,
      returns,
      upTo: 1,
      minPerStock: 1,
      allocations: { 1: { [id['ApexTech']]: '1' } },
    })
  );
});

test('all-cash team (0 stocks) is penalized 15%', () => {
  const { returns } = fixtureSetup();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 3,
    returns,
    upTo: 1,
    allocations: { 1: {} },
    penaltyMode: 'every_quarter',
    penaltyPercent: 15,
  });

  const q1 = r.rounds[0];
  assert.equal(q1.distinctCount, 0);
  assert.equal(q1.penalized, true);
  assert.equal(fromUnits(q1.navBeforePenalty), '100');
  assert.equal(fromUnits(q1.penalty), '15');
  assert.equal(fromUnits(q1.capitalEnd), '85');
});

test('final_only mode penalizes only Q3', () => {
  const { returns, id } = fixtureSetup();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 3,
    returns,
    upTo: 3,
    penaltyMode: 'final_only',
    penaltyPercent: 15,
    allocations: {
      1: { [id['ApexTech']]: '10' }, // 1 stock -> under-diversified
      2: { [id['ApexTech']]: '10' },
      3: { [id['ApexTech']]: '10' },
    },
  });

  // Q1 and Q2 have no penalty in final_only mode
  assert.equal(r.rounds[0].penalized, false);
  assert.equal(r.rounds[0].penalty, 0n);
  assert.equal(r.rounds[1].penalized, false);
  assert.equal(r.rounds[1].penalty, 0n);
  assert.equal(r.rounds[2].penalized, true);
  assert.ok(r.rounds[2].penalty > 0n);
});

test('compounding across 3 quarters with penalty carry-over', () => {
  const { returns, id } = fixtureSetup();
  const r = computeTeam({
    startingCapital: U(100),
    rounds: 3,
    returns,
    upTo: 2,
    penaltyMode: 'every_quarter',
    allocations: {
      1: { [id['ApexTech']]: '10' }, // 1 stock -> penalized
    },
  });

  const q1 = r.rounds[0];
  assert.equal(q1.penalized, true);
  // Q2 capitalStart must equal Q1 capitalEnd (after penalty)
  assert.equal(r.rounds[1].capitalStart, q1.capitalEnd);
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

test('half-up rounding exactness', () => {
  assert.equal(fromUnits(roundHalfUp(toUnits('110.275'))), '110.28');
  assert.equal(fromUnits(roundHalfUp(toUnits('110.274'))), '110.27');
  assert.equal(fromUnits(roundHalfUp(toUnits('98.243'))), '98.24');
  assert.equal(fromUnits(roundHalfUp(toUnits('98.246'))), '98.25');
  assert.equal(fromUnits(roundHalfUp(toUnits('-10.275'))), '-10.28');
});
