// Dry run / preview. Uses its own folder (data-demo), never your real data.
//   npm run demo                 24 teams, stops at the start
//   npm run demo -- 30 12        30 teams, play through to step 12 (0 = start, 24 = final results; each round is 4 steps)
// Then open http://localhost:3100/display.html  (admin PIN 1111, coordinator PIN 2222)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data-demo');
fs.rmSync(dir, { recursive: true, force: true });
const teamCount = Number(process.argv[2] || 24);
const toStep = Number(process.argv[3] || 0);
const port = Number(process.env.PORT || 3100);

const store = new Store(dir);
store.state.settings.pins = { admin: '1111', coordinator: '2222' };
store.save();
const server = createApp(store);
await new Promise((r) => server.listen(port, '0.0.0.0', r));
const base = `http://localhost:${port}`;
const call = async (p, body) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'x-pin': '1111', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};

await call('/api/admin/teams', { names: Array.from({ length: teamCount }, (_, i) => `Team ${String(i + 1).padStart(2, "0")}`) });
const sample = [
  'Quantum chips are in short supply|Fabs report a 6-month backlog. Chip makers expect pricing power.',
  'Rate cut rumours hit banks|Analysts split on whether lenders benefit or lose margin.',
  'Monsoon boosts rural demand|Retailers and logistics firms see early upside.',
  'Aerospace order book swells|Defence contracts lift suppliers across the sector.',
  'Regulator probes a tech giant|Compliance costs could weigh on large software firms.',
  'Energy grid upgrade approved|Public funding flows to utilities and builders.',
];
for (let r = 1; r <= 6; r++) {
  const [headline, body] = sample[r - 1].split('|');
  await call('/api/admin/news', { round: r, items: [{ headline, body }] });
}

// deterministic pseudo-random chits so runs are repeatable
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const fillRound = async () => {
  const ctx = await fetch(base + '/api/entry', { headers: { 'x-pin': '2222' } }).then((r) => r.json());
  for (const t of ctx.teams) {
    const cap = Number(t.capitalStart);
    const k = 3 + Math.floor(rnd() * 4); // 3-6 companies (some teams deliberately under 4)
    const picks = [...ctx.companies].sort(() => rnd() - 0.5).slice(0, k);
    const share = Math.floor((cap * (0.7 + rnd() * 0.3) * 100) / k) / 100;
    const amounts = Object.fromEntries(picks.map((c) => [c.id, String(share)]));
    await fetch(base + '/api/entry', { method: 'POST', headers: { 'x-pin': '2222', 'content-type': 'application/json' }, body: JSON.stringify({ teamId: t.id, round: ctx.round, amounts }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
  }
};
for (let s = 0; s < toStep; s++) {
  const st = await call('/api/admin/state');
  if (st.phase === 'investing') await fillRound();
  await call('/api/admin/advance', { force: true });
}
const st = await call('/api/admin/state');
console.log(`Demo running on ${base}  (${teamCount} teams, now at step ${st.step}: ${st.label}, round ${st.round})`);
console.log('Admin PIN 1111, coordinator PIN 2222. Ctrl+C to stop.');
