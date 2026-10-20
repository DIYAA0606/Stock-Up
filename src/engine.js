// Calculation engine. All money and growth values are exact BigInt integers scaled by 1e-6
// (1 Cr = 1_000_000 units, +18% = 180_000 units). Nothing here is rounded; rounding is display-only.

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

/**
 * Parse one growth cell from the sheet.
 *  "0.18"     -> +18%   (plain numbers are fractions)
 *  "-0.06"    -> -6%
 *  "-6.00%"   -> -6%    (anything with a % sign is a percentage)
 *  "-100.00%" -> -100%
 * Values below -100% are clamped to -100% (a position cannot go below zero).
 */
export function parseGrowth(token) {
  const t = String(token).trim();
  let u;
  if (t.endsWith('%')) u = toUnits(t.slice(0, -1)) / 100n;
  else u = toUnits(t);
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
 *  - upTo: number of rounds whose results are known (exit values are computed for rounds <= upTo)
 * Round r: capitalStart -> invest amounts, rest stays as cash (flat) -> exit = amount * (1 + growth)
 *          capitalEnd = cash + sum(exit). capitalEnd becomes next round's capitalStart.
 */
export function computeTeam({ startingCapital, rounds, returns, allocations, upTo }) {
  let capital = startingCapital;
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    const alloc = allocations[r];
    const amounts = {};
    let invested = 0n;
    if (alloc) {
      for (const [cid, v] of Object.entries(alloc)) {
        const u = toUnits(v);
        if (u < 0n) throw new Error('Negative investment amount');
        if (u > 0n) {
          amounts[cid] = u;
          invested += u;
        }
      }
    }
    const row = {
      round: r,
      entered: !!alloc,
      capitalStart: capital,
      invested,
      cash: capital - invested,
      amounts,
      lines: [],
      exitTotal: null,
      capitalEnd: null,
      overBudget: invested > capital,
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
    row.capitalEnd = row.cash + exitTotal;
    capital = row.capitalEnd;
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

/** Parse a pasted sheet (tab or comma separated): Company, Q1..Qn. */
export function parseReturnsCsv(text, rounds) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('Need a header row and at least one company row');
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((x) => x.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]);
  if (header.length !== rounds + 1) throw new Error(`Header must be Company plus ${rounds} quarter columns (found ${header.length} columns)`);
  const companies = [];
  const seen = new Set();
  lines.slice(1).forEach((line, idx) => {
    const cells = split(line);
    const name = cells[0];
    if (!name) throw new Error(`Row ${idx + 2}: missing company name`);
    if (seen.has(name.toLowerCase())) throw new Error(`Row ${idx + 2}: duplicate company "${name}"`);
    seen.add(name.toLowerCase());
    if (cells.length !== rounds + 1) throw new Error(`Row ${idx + 2} (${name}): expected ${rounds} values, found ${cells.length - 1}`);
    const returns = cells.slice(1).map((tok, q) => {
      try {
        return fromUnits(parseGrowth(tok));
      } catch {
        throw new Error(`Row ${idx + 2} (${name}), Q${q + 1}: cannot read "${tok}"`);
      }
    });
    companies.push({ name, returns });
  });
  return companies;
}
