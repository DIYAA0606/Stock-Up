// Event logic on top of the engine. Everything here is a function of the state object (see store.js).
import { toUnits, fromUnits, computeTeam, rankItems, buildReturns, parseReturnsCsv, SCALE } from './engine.js';

const PHASES = ['news', 'investing', 'entry', 'revealed'];

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- timeline ----------
export function steps(R) {
  const s = [];
  for (let r = 1; r <= R; r++) for (const phase of PHASES) s.push({ round: r, phase });
  s.push({ round: R, phase: 'final' });
  return s;
}
export const current = (st) => steps(st.settings.rounds)[st.step];

export function phaseLabel(round, phase) {
  if (phase === 'news') return round === 1 ? 'Company Information Release' : 'News Burst';
  if (phase === 'investing') return 'Investment Window';
  if (phase === 'entry') return 'Capital Update';
  if (phase === 'revealed') return `Quarter ${round} Results`;
  return 'Final Results';
}

/** How many rounds' results are visible to everyone. */
export function revealedThrough(st) {
  const S = steps(st.settings.rounds);
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

function computeFor(st, team, upTo, returns) {
  return computeTeam({
    startingCapital: startUnits(st),
    rounds: st.settings.rounds,
    returns: returns || buildReturns(st.companies, st.settings.rounds),
    allocations: allocFor(st, team.id),
    upTo,
  });
}

const pct = (a, b) => (b === 0n ? null : Number(((a - b) * 100000n) / b) / 1000);

// ---------- public board ----------
export function buildBoard(st, { full = false } = {}) {
  const R = st.settings.rounds;
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
    const t = {
      id: team.id,
      name: team.name,
      worth: fromUnits(comp.worth),
      rank: rank.get(team.id),
      prevRank: prevRank ? prevRank.get(team.id) : null,
      change: prevRank ? prevRank.get(team.id) - rank.get(team.id) : null,
      lastReturnPct: last ? pct(last.capitalEnd, last.capitalStart) : null,
      history: done.map((x) => fromUnits(x.capitalEnd)),
    };
    if (full) {
      t.rounds = comp.rounds.map((x) => ({
        round: x.round,
        entered: x.entered,
        capitalStart: fromUnits(x.capitalStart),
        invested: fromUnits(x.invested),
        cash: fromUnits(x.cash),
        exitTotal: x.exitTotal === null ? null : fromUnits(x.exitTotal),
        capitalEnd: x.capitalEnd === null ? null : fromUnits(x.capitalEnd),
        overBudget: x.overBudget,
      }));
    }
    return t;
  });
  teams.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  if (!full && c.phase === 'final') {
    const hiddenCount = Math.max(0, teams.length - st.finalReveal);
    teams = teams.map((t, i) => (i < hiddenCount ? { hidden: true, position: i + 1 } : t));
  }

  return {
    phase: c.phase,
    round: c.round,
    label: phaseLabel(c.round, c.phase),
    rounds: R,
    revealedThrough: rev,
    startingCapital: st.settings.startingCapital,
    entryOpen: c.phase === 'investing' || c.phase === 'entry',
    phaseEndsAt: st.phaseEndsAt,
    serverNow: Date.now(),
    finalReveal: st.finalReveal,
    teams,
    // Growth figures are only ever sent for rounds that have been revealed.
    companies: st.companies.map((co) => ({ id: co.id, name: co.name, growth: full ? co.returns : co.returns.slice(0, rev) })),
    news: c.phase === 'final' ? [] : st.news[c.round] || [],
  };
}

// ---------- coordinator entry ----------
/**
 * @param {object} st                  Full game state
 * @param {string} role                'admin' | 'coordinator'
 * @param {string|null} requestedRound Round override (admin only)
 * @param {Array|null}  teamsOverride  Pre-filtered team list (coordinator isolation)
 */
export function entryContext(st, role, requestedRound, teamsOverride = null) {
  const c = current(st);
  const maxRound = c.round; // nobody can enter a future round
  let round = c.round;
  if (role === 'admin' && requestedRound) round = Math.min(Math.max(1, Number(requestedRound)), maxRound);
  const returns = buildReturns(st.companies, st.settings.rounds);
  const writable = role === 'admin' ? true : round === c.round && (c.phase === 'investing' || c.phase === 'entry');
  // Use the override (coordinator's assigned teams) or all teams (admin)
  const srcTeams = teamsOverride !== null ? teamsOverride : st.teams;
  const teams = srcTeams.map((t) => {
    const comp = computeFor(st, t, st.settings.rounds, returns); // full projection: capitalStart only depends on earlier rounds
    const row = comp.rounds[round - 1];
    const alloc = (st.allocations[t.id] || {})[round];
    return {
      id: t.id,
      name: t.name,
      entered: !!alloc,
      capitalStart: fromUnits(row.capitalStart),
      amounts: alloc ? alloc.amounts : {},
    };
  });
  return {
    phase: c.phase,
    round: c.round,
    selectedRound: round,
    label: phaseLabel(c.round, c.phase),
    writable,
    role,
    phaseEndsAt: st.phaseEndsAt,
    serverNow: Date.now(),
    companies: st.companies.map((co) => ({ id: co.id, name: co.name })), // names only, never growth
    teams,
  };
}

export function applyEntry(st, { teamId, round, amounts, role, coordId }) {
  const R = st.settings.rounds;
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
  const clean = {};
  for (const [cid, v] of Object.entries(amounts || {})) {
    if (!st.companies.some((co) => co.id === cid)) throw new HttpError(400, `Unknown company ${cid}`);
    if (v === '' || v === null || v === undefined) continue;
    let u;
    try {
      u = toUnits(v);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (u < 0n) throw new HttpError(400, 'Amounts cannot be negative');
    if (u > 0n) clean[cid] = fromUnits(u);
  }

  // Apply to a copy, then check every team-round budget so a late correction can never break a later round.
  const trial = { ...st, allocations: { ...st.allocations, [teamId]: { ...(st.allocations[teamId] || {}) } } };
  trial.allocations[teamId][round] = { amounts: clean, by: coordId || role, at: Date.now() };
  const comp = computeFor(trial, team, R);
  const bad = comp.rounds.find((x) => x.overBudget);
  if (bad) {
    const label = bad.round === round ? 'This chit' : `The chit already entered for round ${bad.round}`;
    throw new HttpError(422, `${label} invests ${fromUnits(bad.invested)} Cr but only ${fromUnits(bad.capitalStart)} Cr is available.`, {
      round: bad.round,
      invested: fromUnits(bad.invested),
      available: fromUnits(bad.capitalStart),
    });
  }
  st.allocations[teamId] = trial.allocations[teamId];
  return { team: team.name, round, invested: fromUnits(comp.rounds[round - 1].invested), cash: fromUnits(comp.rounds[round - 1].cash) };
}

// ---------- admin ----------
export function advance(st, { force = false } = {}) {
  const S = steps(st.settings.rounds);
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

/** Wipe chits and go back to the start (used after a dry run). Teams, news and growth data stay unless clearTeams. */
export function resetEvent(st, { clearTeams = false } = {}) {
  st.allocations = {};
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
}

export function setNews(st, round, items) {
  round = Number(round);
  if (!Number.isInteger(round) || round < 1 || round > st.settings.rounds) throw new HttpError(400, 'Invalid round');
  st.news[round] = (items || [])
    .map((i) => ({ headline: String(i.headline || '').trim(), body: String(i.body || '').trim() }))
    .filter((i) => i.headline || i.body)
    .slice(0, 6);
}

export function setReturns(st, csv) {
  let parsed;
  try {
    parsed = parseReturnsCsv(csv, st.settings.rounds);
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
}

export function setSettings(st, { startingCapital, durations }) {
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
}

export function adminState(st) {
  const board = buildBoard(st, { full: true });
  const c = current(st);
  const missing =
    c.phase === 'investing' || c.phase === 'entry' ? st.teams.filter((t) => !(st.allocations[t.id] || {})[c.round]).map((t) => t.name) : [];
  const S = steps(st.settings.rounds);
  return {
    ...board,
    settings: { startingCapital: st.settings.startingCapital, rounds: st.settings.rounds, durations: st.settings.durations },
    newsByRound: st.news,
    missing,
    step: st.step,
    totalSteps: S.length,
    nextLabel: st.step < S.length - 1 ? phaseLabel(S[st.step + 1].round, S[st.step + 1].phase) + (S[st.step + 1].phase === 'final' ? '' : ` · Round ${S[st.step + 1].round}`) : null,
  };
}

export function exportCsv(st) {
  const R = st.settings.rounds;
  const returns = buildReturns(st.companies, R);
  const head = ['Team', 'Round', 'CapitalStart', 'Invested', 'Cash', 'ExitTotal', 'CapitalEnd', ...st.companies.map((c) => `Invested:${c.name}`)];
  const rows = [head];
  for (const t of st.teams) {
    const comp = computeFor(st, t, revealedThrough(st), returns);
    for (const r of comp.rounds) {
      if (r.capitalEnd === null && !r.entered) continue;
      rows.push([
        t.name,
        r.round,
        fromUnits(r.capitalStart),
        fromUnits(r.invested),
        fromUnits(r.cash),
        r.exitTotal === null ? '' : fromUnits(r.exitTotal),
        r.capitalEnd === null ? '' : fromUnits(r.capitalEnd),
        ...st.companies.map((c) => (r.amounts[c.id] ? fromUnits(r.amounts[c.id]) : '')),
      ]);
    }
  }
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

export { SCALE };
