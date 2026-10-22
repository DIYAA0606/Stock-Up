// Event logic on top of the engine. Everything here is a function of the state object (see store.js).
import {
  toUnits,
  fromUnits,
  roundHalfUp,
  computeTeam,
  rankItems,
  buildReturns,
  parseReturnsCsv,
  SCALE,
} from './engine.js';
import { saveReturnsCsv } from './seed.js';

export const PHASES = ['news', 'investing', 'entry', 'revealed'];

export const ROUND_NAMES = {
  1: 'The Boom Begins',
  2: 'The Bubble Grows',
  3: 'The Calamity',
  4: 'Picking Up the Pieces',
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- timeline ----------
export function steps(R = 4) {
  const s = [];
  for (let r = 1; r <= R; r++) for (const phase of PHASES) s.push({ round: r, phase });
  s.push({ round: R, phase: 'final' });
  return s;
}
export const current = (st) => steps(st.settings.rounds || 4)[st.step];

export function phaseLabel(round, phase) {
  if (phase === 'news') return round === 1 ? 'Information Release' : 'News Burst';
  if (phase === 'investing') return 'Investment Window';
  if (phase === 'entry') return 'Capital Update';
  if (phase === 'revealed') return `Quarter ${round} Results`;
  return 'Final Results';
}

/** How many rounds' results are visible to everyone. */
export function revealedThrough(st) {
  const S = steps(st.settings.rounds || 4);
  let n = 0;
  for (let i = 0; i <= st.step; i++) {
    if (S[i].phase === 'revealed') n = S[i].round;
  }
  return n;
}

function phaseMinutes(st, round, phase) {
  const d = st.settings.durations;
  if (phase === 'news') return round === 1 ? d.info : d.news;
  if (phase === 'investing') return d.investing;
  if (phase === 'entry') return d.entry;
  return null;
}

function stampPhase(st) {
  const c = current(st);
  st.phaseStartedAt = Date.now();
  const m = phaseMinutes(st, c.round, c.phase);
  st.phaseEndsAt = m ? st.phaseStartedAt + m * 60000 : null;
}

// ---------- computation helpers ----------
const startUnits = (st) => toUnits(st.settings.startingCapital);

function allocFor(st, teamId) {
  const out = {};
  for (const [r, v] of Object.entries(st.allocations[teamId] || {})) out[r] = v.amounts;
  return out;
}

export function computeFor(st, team, upTo, returns) {
  return computeTeam({
    startingCapital: startUnits(st),
    rounds: st.settings.rounds || 4,
    returns: returns || buildReturns(st.companies, st.settings.rounds || 4),
    allocations: allocFor(st, team.id),
    rumors: st.rumors?.[team.id] || {},
    upTo,
    penaltyMode: st.settings.penaltyMode || 'every_quarter',
    penaltyPercent: st.settings.penaltyPercent !== undefined ? Number(st.settings.penaltyPercent) : 15,
    minPerStock: st.settings.minPerStock || '1',
    rumorFee: st.settings.rumorFee || '5',
  });
}

const pct = (a, b) => (b === 0n ? null : Number(((a - b) * 100000n) / b) / 1000);

// ---------- public board ----------
export function buildBoard(st, { full = false, admin = false } = {}) {
  const R = st.settings.rounds || 4;
  const c = current(st);
  const rev = revealedThrough(st);
  const returns = buildReturns(st.companies, R);

  const rows = st.teams.map((t) => ({ team: t, comp: computeFor(st, t, rev, returns) }));
  const rank = rankItems(rows.map((r) => ({ id: r.team.id, worth: r.comp.worth })));
  let prevRank = null;
  if (rev >= 2) {
    prevRank = rankItems(rows.map((r) => ({ id: r.team.id, worth: r.comp.rounds[rev - 2].capitalEnd })));
  }

  let teams = rows.map(({ team, comp }) => {
    const done = comp.rounds.filter((x) => x.capitalEnd !== null);
    const last = done[done.length - 1];
    const curRound = comp.rounds[c.round - 1];
    const t = {
      id: team.id,
      name: team.name,
      worth: fromUnits(comp.worth),
      rank: rank.get(team.id),
      prevRank: prevRank ? prevRank.get(team.id) : null,
      change: prevRank ? prevRank.get(team.id) - rank.get(team.id) : null,
      lastReturnPct: last ? pct(last.capitalEnd, last.capitalStart) : null,
      history: done.map((x) => fromUnits(x.capitalEnd)),
      rumorCount: curRound ? curRound.rumorCount : 0,
      rumorFees: curRound ? fromUnits(curRound.rumorFees) : '0',
      penalized: curRound ? curRound.penalized : false,
      penalty: curRound && curRound.penalty !== null ? fromUnits(curRound.penalty) : null,
      distinctCount: curRound ? curRound.distinctCount : 0,
    };
    if (full) {
      t.rounds = comp.rounds.map((x) => ({
        round: x.round,
        entered: x.entered,
        capitalStart: fromUnits(x.capitalStart),
        rumorCount: x.rumorCount,
        rumorFees: fromUnits(x.rumorFees),
        investableCash: fromUnits(x.investableCash),
        invested: fromUnits(x.invested),
        cash: fromUnits(x.cash),
        distinctCount: x.distinctCount,
        exitTotal: x.exitTotal === null ? null : fromUnits(x.exitTotal),
        navBeforePenalty: x.navBeforePenalty === null ? null : fromUnits(x.navBeforePenalty),
        penalized: x.penalized,
        penalty: x.penalty === null ? null : fromUnits(x.penalty),
        capitalEnd: x.capitalEnd === null ? null : fromUnits(x.capitalEnd),
        overBudget: x.overBudget,
      }));
    }
    return t;
  });
  teams.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const hideStandings = !admin && rev >= 3 && c.phase !== 'final';
  if (hideStandings) {
    teams = rows.map(({ team }) => ({
      id: team.id,
      name: team.name,
    }));
  }

  if (!full && c.phase === 'final') {
    const hiddenCount = Math.max(0, teams.length - st.finalReveal);
    teams = teams.map((t, i) => (i < hiddenCount ? { hidden: true, position: i + 1 } : t));
  }

  return {
    phase: c.phase,
    round: c.round,
    roundName: ROUND_NAMES[c.round] || '',
    label: phaseLabel(c.round, c.phase),
    rounds: R,
    revealedThrough: rev,
    startingCapital: st.settings.startingCapital,
    entryOpen: c.phase === 'investing' || c.phase === 'entry',
    phaseEndsAt: st.phaseEndsAt,
    serverNow: Date.now(),
    finalReveal: st.finalReveal,
    standingsHidden: hideStandings,
    standingsMessage: hideStandings ? 'Standings hidden until final reveal' : null,
    teams,
    companies: st.companies.map((co) => ({ id: co.id, name: co.name, growth: (full || admin) ? co.returns : co.returns.slice(0, rev) })),
    news: c.phase === 'final' ? [] : st.news[c.round] || [],
  };
}

// ---------- coordinator entry ----------
export function entryContext(st, role, requestedRound, teamsOverride = null) {
  const c = current(st);
  const maxRound = c.round;
  let round = c.round;
  if (role === 'admin' && requestedRound) round = Math.min(Math.max(1, Number(requestedRound)), maxRound);
  const returns = buildReturns(st.companies, st.settings.rounds || 4);
  const writable = role === 'admin' ? true : round === c.round && (c.phase === 'investing' || c.phase === 'entry');
  const srcTeams = teamsOverride !== null ? teamsOverride : st.teams;

  if (role === 'coordinator' && srcTeams.length === 0) {
    return {
      phase: c.phase,
      round: c.round,
      roundName: ROUND_NAMES[c.round] || '',
      selectedRound: round,
      label: phaseLabel(c.round, c.phase),
      writable: false,
      role,
      noTeamAssigned: true,
      message: 'No team assigned, contact the organizer',
      companies: [],
      teams: [],
      minPerStock: st.settings.minPerStock || '1',
      rumorFee: st.settings.rumorFee || '5',
      penaltyPercent: st.settings.penaltyPercent !== undefined ? st.settings.penaltyPercent : 15,
    };
  }

  const rev = revealedThrough(st);
  const teams = srcTeams.map((t) => {
    const comp = computeFor(st, t, st.settings.rounds || 4, returns);
    const row = comp.rounds[round - 1];
    const alloc = (st.allocations[t.id] || {})[round];

    const results = comp.rounds.slice(0, rev).map((rRow, idx) => {
      const rNum = idx + 1;
      const rAlloc = (st.allocations[t.id] || {})[rNum];
      const stocks = st.companies.map((co) => {
        const allocated = rAlloc && rAlloc.amounts && rAlloc.amounts[co.id] ? rAlloc.amounts[co.id] : '0';
        const gPct = co.growth && co.growth[idx] !== undefined ? co.growth[idx] : 0;
        const allocU = toUnits(allocated);
        const growthUnits = BigInt(Math.round(gPct * 10000));
        const delta = (allocU * growthUnits) / 1000000n;
        const exitU = allocU + delta;
        return {
          companyId: co.id,
          name: co.name,
          allocated,
          changePct: gPct,
          exitValue: fromUnits(exitU < 0n ? 0n : exitU),
        };
      }).filter((s) => Number(s.allocated) > 0);

      return {
        quarter: rNum,
        roundName: ROUND_NAMES[rNum] || '',
        stocks,
        rumorCount: rRow.rumorCount,
        rumorFees: fromUnits(rRow.rumorFees),
        cash: fromUnits(rRow.cash),
        distinctCount: rRow.distinctCount,
        penalized: rRow.penalized,
        penalty: rRow.penalty !== null ? fromUnits(rRow.penalty) : '0',
        navBeforePenalty: rRow.navBeforePenalty !== null ? fromUnits(rRow.navBeforePenalty) : fromUnits(rRow.capitalEnd),
        newNav: fromUnits(rRow.capitalEnd),
        nextQuarterCash: fromUnits(rRow.capitalEnd),
      };
    });

    return {
      id: t.id,
      name: t.name,
      entered: !!alloc,
      capitalStart: fromUnits(row.capitalStart),
      rumorCount: row.rumorCount,
      rumorFees: fromUnits(row.rumorFees),
      investableCash: fromUnits(row.investableCash),
      distinctCount: row.distinctCount,
      amounts: alloc ? alloc.amounts : {},
      results,
    };
  });
  return {
    phase: c.phase,
    round: c.round,
    roundName: ROUND_NAMES[c.round] || '',
    selectedRound: round,
    label: phaseLabel(c.round, c.phase),
    writable,
    role,
    phaseEndsAt: st.phaseEndsAt,
    serverNow: Date.now(),
    companies: st.companies.map((co) => ({ id: co.id, name: co.name })),
    teams,
    minPerStock: st.settings.minPerStock || '1',
    rumorFee: st.settings.rumorFee || '5',
    penaltyPercent: st.settings.penaltyPercent !== undefined ? st.settings.penaltyPercent : 15,
  };
}

export function applyEntry(st, { teamId, round, amounts, role, coordId }) {
  const R = st.settings.rounds || 4;
  const c = current(st);
  const team = st.teams.find((t) => t.id === teamId);
  if (!team) throw new HttpError(404, 'Unknown team');
  round = Number(round);
  if (!Number.isInteger(round) || round < 1 || round > R) throw new HttpError(400, 'Invalid round');
  if (round > c.round) throw new HttpError(409, `Round ${round} has not started yet`);
  if (role !== 'admin') {
    if (round !== c.round || !(c.phase === 'investing' || c.phase === 'entry')) {
      throw new HttpError(409, 'Entry is closed for this round. Ask the admin to open it or make a correction.');
    }
  }

  const minUnits = toUnits(st.settings.minPerStock || '1');
  const clean = {};
  for (const [cid, v] of Object.entries(amounts || {})) {
    const co = st.companies.find((co) => co.id === cid);
    if (!co) throw new HttpError(400, `Unknown company ${cid}`);
    if (v === '' || v === null || v === undefined) continue;
    let u;
    try {
      u = toUnits(v);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (u < 0n) throw new HttpError(400, 'Amounts cannot be negative');
    if (u > 0n && u < minUnits) {
      throw new HttpError(400, `Amount for ${co.name} (${fromUnits(u)} Cr) must be at least ${fromUnits(minUnits)} Cr (or 0)`);
    }
    if (u > 0n) clean[cid] = fromUnits(u);
  }

  const trial = {
    ...st,
    allocations: { ...st.allocations, [teamId]: { ...(st.allocations[teamId] || {}) } },
  };
  trial.allocations[teamId][round] = { amounts: clean, by: coordId || role, at: Date.now() };
  const comp = computeFor(trial, team, R);
  const bad = comp.rounds.find((x) => x.overBudget);
  if (bad) {
    const label = bad.round === round ? 'This chit' : `The chit already entered for round ${bad.round}`;
    throw new HttpError(
      422,
      `${label} invests ${fromUnits(bad.invested)} Cr but only ${fromUnits(bad.investableCash)} Cr is investable (available: ${fromUnits(bad.capitalStart)} Cr, rumor fees: ${fromUnits(bad.rumorFees)} Cr).`,
      {
        round: bad.round,
        invested: fromUnits(bad.invested),
        available: fromUnits(bad.capitalStart),
        investable: fromUnits(bad.investableCash),
        rumorFees: fromUnits(bad.rumorFees),
      }
    );
  }

  if (!st.allocations[teamId]) st.allocations[teamId] = {};
  st.allocations[teamId][round] = trial.allocations[teamId][round];
  const rRow = comp.rounds[round - 1];
  return {
    team: team.name,
    round,
    invested: fromUnits(rRow.invested),
    cash: fromUnits(rRow.cash),
    rumorCount: rRow.rumorCount,
    rumorFees: fromUnits(rRow.rumorFees),
  };
}

export function buyRumor(st, { teamId, round, role, coordId }) {
  const R = st.settings.rounds || 4;
  const c = current(st);
  const team = st.teams.find((t) => t.id === teamId);
  if (!team) throw new HttpError(404, 'Unknown team');
  round = Number(round);
  if (!Number.isInteger(round) || round < 1 || round > R) throw new HttpError(400, 'Invalid round');
  if (round > c.round) throw new HttpError(409, `Round ${round} has not started yet`);
  if (role !== 'admin') {
    if (round !== c.round || !(c.phase === 'investing' || c.phase === 'entry')) {
      throw new HttpError(409, 'Rumor purchase is closed for this round.');
    }
  }

  if (!st.rumors) st.rumors = {};
  if (!st.rumors[teamId]) st.rumors[teamId] = {};
  const currentCount = Number(st.rumors[teamId][round] || 0);
  const newCount = currentCount + 1;

  const trial = {
    ...st,
    rumors: { ...st.rumors, [teamId]: { ...(st.rumors[teamId] || {}), [round]: newCount } },
  };
  const comp = computeFor(trial, team, R);
  const bad = comp.rounds.find((x) => x.overBudget);
  if (bad) {
    throw new HttpError(
      422,
      `Cannot buy rumor: total rumor fees (${fromUnits(bad.rumorFees)} Cr) plus allocations (${fromUnits(bad.invested)} Cr) would exceed capital (${fromUnits(bad.capitalStart)} Cr).`
    );
  }

  st.rumors[teamId][round] = newCount;
  const teamComp = computeFor(st, team, R);
  const rRow = teamComp.rounds[round - 1];
  return {
    team: team.name,
    round,
    rumorCount: newCount,
    rumorFees: fromUnits(rRow.rumorFees),
    investableCash: fromUnits(rRow.investableCash),
  };
}

export function adjustRumors(st, { teamId, round, count }) {
  const R = st.settings.rounds || 4;
  const team = st.teams.find((t) => t.id === teamId);
  if (!team) throw new HttpError(404, 'Unknown team');
  round = Number(round);
  count = Number(count);
  if (!Number.isInteger(count) || count < 0) throw new HttpError(400, 'Rumor count must be non-negative integer');
  if (!st.rumors) st.rumors = {};
  if (!st.rumors[teamId]) st.rumors[teamId] = {};
  const before = Number(st.rumors[teamId][round] || 0);

  const trial = {
    ...st,
    rumors: { ...st.rumors, [teamId]: { ...(st.rumors[teamId] || {}), [round]: count } },
  };
  const comp = computeFor(trial, team, R);
  const bad = comp.rounds.find((x) => x.overBudget);
  if (bad) {
    throw new HttpError(
      422,
      `Cannot adjust rumors: total fees (${fromUnits(bad.rumorFees)} Cr) plus allocations (${fromUnits(bad.invested)} Cr) would exceed capital (${fromUnits(bad.capitalStart)} Cr).`
    );
  }

  st.rumors[teamId][round] = count;
  return { team: team.name, round, before, after: count };
}

// ---------- admin ----------
export function advance(st, { force = false } = {}) {
  const S = steps(st.settings.rounds || 4);
  if (st.step >= S.length - 1) throw new HttpError(409, 'Already at the final results');
  const c = current(st);
  if (c.phase === 'entry' && !force) {
    const missing = st.teams.filter((t) => !(st.allocations[t.id] || {})[c.round]).map((t) => t.name);
    if (missing.length) {
      throw new HttpError(409, `${missing.length} team(s) have no chit entered for round ${c.round}. Revealing now treats them as holding all cash.`, { missing });
    }
  }
  st.step += 1;
  stampPhase(st);
}

export function back(st) {
  if (st.step === 0) throw new HttpError(409, 'Already at the start');
  st.step -= 1;
  st.finalReveal = 0;
  stampPhase(st);
}

export function finalReveal(st, action) {
  if (current(st).phase !== 'final') throw new HttpError(409, 'Final reveal is only available on the final results step');
  const n = st.teams.length;
  if (action === 'next') st.finalReveal = Math.min(n, st.finalReveal + 1);
  else if (action === 'all') st.finalReveal = n;
  else if (action === 'reset') st.finalReveal = 0;
  else throw new HttpError(400, 'Unknown action');
}

/** Wipe chits and rumors and go back to the start. */
export function resetEvent(st, { clearTeams = false } = {}) {
  st.allocations = {};
  st.rumors = {};
  st.step = 0;
  st.finalReveal = 0;
  if (clearTeams) {
    st.teams = [];
    st.nextTeamId = 0;
  }
  stampPhase(st);
}

export function addTeams(st, names) {
  const added = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    if (st.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) continue;
    st.nextTeamId += 1;
    const t = { id: `t${st.nextTeamId}`, name };
    st.teams.push(t);
    added.push(t);
  }
  return added;
}

export function removeTeam(st, id) {
  const i = st.teams.findIndex((t) => t.id === id);
  if (i < 0) throw new HttpError(404, 'Unknown team');
  st.teams.splice(i, 1);
  delete st.allocations[id];
  if (st.rumors) delete st.rumors[id];
}

export function setNews(st, round, items) {
  round = Number(round);
  if (!Number.isInteger(round) || round < 1 || round > (st.settings.rounds || 4)) throw new HttpError(400, 'Invalid round');
  st.news[round] = (items || [])
    .map((i) => ({ headline: String(i.headline || '').trim(), body: String(i.body || '').trim() }))
    .filter((i) => i.headline || i.body)
    .slice(0, 6);
}

export function setReturns(st, csv) {
  let parsed;
  try {
    parsed = parseReturnsCsv(csv, st.settings.rounds || 4);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  const byName = new Map(st.companies.map((c) => [c.name.toLowerCase(), c]));
  const next = [];
  for (const p of parsed) {
    const old = byName.get(p.name.toLowerCase());
    if (old) next.push({ ...old, name: p.name, returns: p.returns });
    else {
      st.nextCompanyId += 1;
      next.push({ id: `c${st.nextCompanyId}`, name: p.name, returns: p.returns });
    }
  }
  const keep = new Set(next.map((c) => c.id));
  for (const [teamId, rounds] of Object.entries(st.allocations)) {
    for (const [r, v] of Object.entries(rounds)) {
      for (const cid of Object.keys(v.amounts)) {
        if (!keep.has(cid)) {
          const gone = st.companies.find((c) => c.id === cid)?.name || cid;
          throw new HttpError(409, `Cannot remove "${gone}": team ${st.teams.find((t) => t.id === teamId)?.name} invested in it in round ${r}.`);
        }
      }
    }
  }
  st.companies = next;
  st.returnsIsSample = false;
  st.returnsWarnings = parsed.warnings || [];
  try {
    saveReturnsCsv(csv);
  } catch (e) {
    console.warn('Failed to overwrite config/returns.csv:', e.message);
  }
  return { count: next.length, warnings: st.returnsWarnings };
}

export function setSettings(st, { startingCapital, durations, penaltyMode, penaltyPercent, minPerStock, rumorFee }) {
  if (startingCapital !== undefined) {
    const anyEntry = Object.keys(st.allocations).length > 0;
    if (anyEntry && String(startingCapital) !== st.settings.startingCapital) {
      throw new HttpError(409, 'Starting capital cannot change once chits have been entered');
    }
    let u;
    try {
      u = toUnits(startingCapital);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (u <= 0n) throw new HttpError(400, 'Starting capital must be positive');
    st.settings.startingCapital = fromUnits(u);
  }
  if (durations) {
    for (const k of ['info', 'news', 'investing', 'entry']) {
      if (durations[k] !== undefined) {
        const v = Number(durations[k]);
        if (!(v >= 0 && v <= 240)) throw new HttpError(400, `Invalid duration for ${k}`);
        st.settings.durations[k] = v;
      }
    }
  }
  if (penaltyMode !== undefined) {
    if (!['every_quarter', 'final_only'].includes(penaltyMode)) {
      throw new HttpError(400, 'Invalid penaltyMode: must be every_quarter or final_only');
    }
    st.settings.penaltyMode = penaltyMode;
  }
  if (penaltyPercent !== undefined) {
    const p = Number(penaltyPercent);
    if (!(p >= 0 && p <= 100)) throw new HttpError(400, 'Invalid penaltyPercent');
    st.settings.penaltyPercent = p;
  }
  if (minPerStock !== undefined) {
    const u = toUnits(minPerStock);
    if (u < 0n) throw new HttpError(400, 'minPerStock cannot be negative');
    st.settings.minPerStock = fromUnits(u);
  }
  if (rumorFee !== undefined) {
    const u = toUnits(rumorFee);
    if (u < 0n) throw new HttpError(400, 'rumorFee cannot be negative');
    st.settings.rumorFee = fromUnits(u);
  }
}

export function adminState(st, coordinators = []) {
  const board = buildBoard(st, { full: true });
  const c = current(st);
  const missing =
    c.phase === 'investing' || c.phase === 'entry' ? st.teams.filter((t) => !(st.allocations[t.id] || {})[c.round]).map((t) => t.name) : [];
  const S = steps(st.settings.rounds || 4);
  const coordByTeam = new Map();
  for (const cd of coordinators) {
    for (const tid of cd.assignedTeams || []) coordByTeam.set(tid, cd.code);
  }
  const teamsWithCoord = board.teams.map((t) => {
    const rAlloc = (st.allocations[t.id] || {})[c.round];
    const rRow = t.rounds && t.rounds[c.round - 1];
    return {
      ...t,
      coordinator: coordByTeam.get(t.id) || 'Unassigned',
      submitted: !!rAlloc,
      allocated: rRow ? rRow.invested : '0',
      cashLeft: rRow ? rRow.cash : t.worth,
      lastNav: t.worth,
    };
  });

  return {
    ...board,
    teams: teamsWithCoord,
    settings: {
      startingCapital: st.settings.startingCapital,
      rounds: st.settings.rounds || 4,
      durations: st.settings.durations,
      penaltyMode: st.settings.penaltyMode || 'every_quarter',
      penaltyPercent: st.settings.penaltyPercent !== undefined ? st.settings.penaltyPercent : 15,
      minPerStock: st.settings.minPerStock || '1',
      rumorFee: st.settings.rumorFee || '5',
    },
    returnsIsSample: st.returnsIsSample ?? true,
    returnsWarnings: st.returnsWarnings || [],
    newsByRound: st.news,
    missing,
    step: st.step,
    totalSteps: S.length,
    nextLabel:
      st.step < S.length - 1
        ? phaseLabel(S[st.step + 1].round, S[st.step + 1].phase) + (S[st.step + 1].phase === 'final' ? '' : ` — Quarter ${S[st.step + 1].round}`)
        : null,
  };
}

export function exportCsv(st, coordinators = []) {
  const R = st.settings.rounds || 4;
  const returns = buildReturns(st.companies, R);
  const coordByTeam = new Map();
  for (const cd of coordinators) {
    for (const tid of cd.assignedTeams || []) coordByTeam.set(tid, cd.code);
  }

  const head = [
    'Team',
    'Coordinator',
    'Quarter',
    'RumorCount',
    'RumorFees',
    ...st.companies.map((c) => `Allocation:${c.name}`),
    'CashLeft',
    'NavBeforePenalty',
    'Penalty',
    'NavAfterPenalty',
    'Rank',
  ];
  const rows = [head];

  for (const t of st.teams) {
    const comp = computeFor(st, t, revealedThrough(st), returns);
    const coordCode = coordByTeam.get(t.id) || 'Unassigned';
    for (const r of comp.rounds) {
      if (r.capitalEnd === null && !r.entered && r.rumorCount === 0) continue;
      rows.push([
        t.name,
        coordCode,
        r.round,
        r.rumorCount,
        fromUnits(r.rumorFees),
        ...st.companies.map((c) => (r.amounts[c.id] ? fromUnits(r.amounts[c.id]) : '0')),
        fromUnits(r.cash),
        r.navBeforePenalty === null ? '' : fromUnits(r.navBeforePenalty),
        r.penalty === null ? '' : fromUnits(r.penalty),
        r.capitalEnd === null ? '' : fromUnits(r.capitalEnd),
        '', // rank evaluated dynamically per round if needed
      ]);
    }
  }
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

export { SCALE };
