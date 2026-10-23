// Calculation engine. All money and growth values are exact BigInt integers scaled by 1e-6
// (1 Cr = 1_000_000 units, +18% = 180_000 units).
// Quarter closing NAVs are rounded half-up to 2 decimals in Cr (10_000 units).

export const SCALE = 1_000_000n;

/** Decimal string/number -> scaled BigInt. Throws on junk or more than 6 significant decimals. */
export function toUnits(input) {
  let s = String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid number: "${input}"`);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [i, f = ''] = s.split('.');
  if (f.length > 6) {
    if (/[^0]/.test(f.slice(6))) throw new Error(`Too many decimals: "${input}"`);
    f = f.slice(0, 6);
  }
  const u = BigInt(i) * SCALE + BigInt(f.padEnd(6, '0'));
  return neg ? -u : u;
}

/** Scaled BigInt -> exact decimal string (trailing zeros trimmed). */
export function fromUnits(u) {
  const neg = u < 0n;
  if (neg) u = -u;
  const i = u / SCALE;
  const f = (u % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}

/** Round scaled BigInt to 2 decimals in Cr (half-up: nearest 10_000 units). */
export function roundHalfUp(u) {
  if (u >= 0n) {
    return ((u + 5_000n) / 10_000n) * 10_000n;
  } else {
    return -(((-u + 5_000n) / 10_000n) * 10_000n);
  }
}

/**
 * Parse one growth cell from the sheet (percent change per quarter).
 *  "18"       -> +18%  (scaled: 180_000n)
 *  "4.2"      -> +4.2% (scaled: 42_000n)
 *  "-45"      -> -45%  (scaled: -450_000n)
 *  "-100%"    -> -100% (scaled: -1_000_000n)
 * Values below -100% are clamped to -100% (a position cannot go below zero).
 */
export function parseGrowth(token) {
  if (token === undefined || token === null) return 0n;
  let t = String(token).trim();
  if (t === '') return 0n;
  if (t.endsWith('%')) t = t.slice(0, -1).trim();
  if (t.startsWith('+')) t = t.slice(1).trim();
  const u = toUnits(t) / 100n;
  return u < -SCALE ? -SCALE : u;
}

/** companies: [{id, returns:[growth strings...]}] -> array per round of {companyId: BigInt growth} */
export function buildReturns(companies, rounds) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    const m = {};
    for (const c of companies) {
      const raw = c.returns?.[r];
      m[c.id] = raw === undefined || raw === null || raw === '' ? 0n : parseGrowth(raw);
    }
    out.push(m);
  }
  return out;
}

/**
 * Walk one team through the rounds.
 *  - allocations: { [round]: { [companyId]: "amount in Cr" } }
 *  - rumors: { [round]: count }
 *  - upTo: number of rounds whose results are known (exit values are computed for rounds <= upTo)
 *  - penaltyMode: 'every_quarter' | 'final_only'
 *  - penaltyPercent: 15 (deduct 15% of total NAV when distinct stocks < 4)
 *  - minPerStock: 1 (each allocation must be 0 or >= 1 Cr)
 *  - rumorFee: 5 (deducted immediately from available cash per rumor)
 */
export function computeTeam({
  startingCapital,
  rounds = 3,
  returns,
  allocations = {},
  rumors = {},
  upTo,
  penaltyMode = 'every_quarter',
  penaltyPercent = 15,
  minPerStock = 1,
  rumorFee = 5,
}) {
  let capital = startingCapital;
  const out = [];
  const feePerRumor = toUnits(rumorFee);
  const penRate = toUnits(penaltyPercent) / 100n;
  const minUnits = toUnits(minPerStock);

  for (let r = 1; r <= rounds; r++) {
    const alloc = allocations[r];
    const rumorCount = Number(rumors?.[r] || 0);
    const rumorFees = BigInt(rumorCount) * feePerRumor;
    const investableCash = capital - rumorFees;

    const amounts = {};
    let invested = 0n;
    let distinctCount = 0;
    if (alloc) {
      for (const [cid, v] of Object.entries(alloc)) {
        const u = toUnits(v);
        if (u < 0n) throw new Error('Negative investment amount');
        if (u > 0n) {
          if (u < minUnits) {
            throw new Error(`Investment below minimum of ${fromUnits(minUnits)} Cr`);
          }
          amounts[cid] = u;
          invested += u;
          distinctCount++;
        }
      }
    }
    const cashLeft = investableCash - invested;
    const overBudget = invested > investableCash || cashLeft < 0n;

    const row = {
      round: r,
      entered: !!alloc,
      capitalStart: capital,
      rumorCount,
      rumorFees,
      investableCash,
      invested,
      cash: cashLeft,
      distinctCount,
      amounts,
      lines: [],
      exitTotal: null,
      navBeforePenalty: null,
      penalized: false,
      penalty: null,
      capitalEnd: null,
      overBudget,
    };
    out.push(row);
    if (r > upTo) break;

    let exitTotal = 0n;
    for (const [cid, amt] of Object.entries(amounts)) {
      let g = returns[r - 1]?.[cid] ?? 0n;
      if (g < -SCALE) g = -SCALE;
      const exit = (amt * (SCALE + g)) / SCALE;
      row.lines.push({ companyId: cid, amount: amt, growth: g, exit });
      exitTotal += exit;
    }
    row.exitTotal = exitTotal;
    const navBeforePenalty = cashLeft + exitTotal;
    row.navBeforePenalty = navBeforePenalty;

    const isUnderDiversified = distinctCount < 4;
    let applyPenalty = false;
    if (isUnderDiversified) {
      if (penaltyMode === 'every_quarter') applyPenalty = true;
      else if (penaltyMode === 'final_only' && r === rounds) applyPenalty = true;
    }

    let penalty = 0n;
    if (applyPenalty && navBeforePenalty > 0n) {
      penalty = (navBeforePenalty * penRate) / SCALE;
    }
    row.penalized = isUnderDiversified && applyPenalty;
    row.penalty = penalty;

    const navAfterPenalty = navBeforePenalty - penalty;
    // Quarter closing NAV is rounded to 2 decimals (half-up)
    const closingNav = roundHalfUp(navAfterPenalty);
    row.capitalEnd = closingNav;
    capital = closingNav;
  }
  const done = out.filter((x) => x.capitalEnd !== null);
  return { rounds: out, worth: done.length ? done[done.length - 1].capitalEnd : startingCapital };
}

/** Competition ranking (1,2,2,4): equal worth shares a rank. Tie-breaks are intentionally not applied. */
export function rankItems(items) {
  const m = new Map();
  for (const a of items) {
    let better = 0;
    for (const b of items) if (b.worth > a.worth) better++;
    m.set(a.id, better + 1);
  }
  return m;
}

/** Parse a pasted sheet (tab or comma separated): Stock, Q1..Qn. */
export function parseReturnsCsv(text, rounds = null) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('Need a header row and at least one stock row');
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((x) => x.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]);
  const detectedRounds = header.length - 1;
  const numRounds = rounds !== null ? Number(rounds) : detectedRounds;
  if (header.length !== numRounds + 1) {
    throw new Error(`Header must be Stock plus ${numRounds} quarter columns (found ${header.length} columns)`);
  }
  const companies = [];
  const warnings = [];
  const seen = new Set();
  lines.slice(1).forEach((line, idx) => {
    const cells = split(line);
    const name = cells[0];
    if (!name) throw new Error(`Row ${idx + 2}: missing stock name`);
    if (seen.has(name.toLowerCase())) throw new Error(`Row ${idx + 2}: duplicate stock "${name}"`);
    seen.add(name.toLowerCase());
    if (cells.length !== numRounds + 1) {
      throw new Error(`Row ${idx + 2} (${name}): expected ${numRounds} values, found ${cells.length - 1}`);
    }
    const returns = [];
    for (let q = 0; q < numRounds; q++) {
      const tok = cells[q + 1];
      if (tok === undefined || tok === null || String(tok).trim() === '') {
        warnings.push(`Row ${idx + 2} (${name}), Q${q + 1}: missing value defaulted to 0%`);
        returns.push('0');
      } else {
        try {
          parseGrowth(tok);
          let s = String(tok).trim();
          if (s.endsWith('%')) s = s.slice(0, -1).trim();
          if (s.startsWith('+')) s = s.slice(1).trim();
          returns.push(s);
        } catch {
          throw new Error(`Row ${idx + 2} (${name}), Q${q + 1}: cannot read "${tok}"`);
        }
      }
    }
    companies.push({ name, returns });
  });
  companies.warnings = warnings;
  return companies;
}
