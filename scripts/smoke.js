// Smoke test: start server on port 3100 with temp DATA_DIR, drive it over HTTP, stop it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PIN = '999999';
const SESSION_SECRET = 'smoke-secret';
const DATA_DIR = path.join(os.tmpdir(), 'gtg-smoke-' + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });

let results = [];
function check(name, ok, actual, expected) {
  results.push({ name, ok, actual, expected });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}${!ok ? ` (actual=${actual}, expected=${expected})` : ''}`);
}

async function call(method, url, { token, pin, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (pin) headers['x-pin'] = pin;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

const admin = (m, u, body) => call(m, '/api/admin/' + u, { pin: ADMIN_PIN, body });

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      SESSION_SECRET,
      ADMIN_PIN,
      DATA_DIR,
    };
    const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let started = false;
    child.stdout.on('data', (d) => {
      if (!started && d.toString().includes('running')) {
        started = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('exit', (code) => { if (!started) reject(new Error(`Server exited with ${code}`)); });
    setTimeout(() => { if (!started) { child.kill(); reject(new Error('Server start timeout')); } }, 10000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
  });
}

async function advancePhase(pin, phaseName) {
  const r = await admin('POST', 'advance', {});
  if (r.status === 409 && r.data && r.data.missing) {
    await admin('POST', 'advance', { force: true });
  }
}

try {
  console.log('\nStarting smoke test...\n');
  let server = await startServer();

  // ======== CHECK 1: Matrix 10x4 ========
  const retCsv = fs.readFileSync(path.join(ROOT, 'config', 'returns.csv'), 'utf8');
  const retLines = retCsv.trim().split(/\r?\n/).filter(Boolean);
  check('1.1 returns.csv has 10 stocks', retLines.length - 1 === 10, retLines.length - 1, 10);
  const cols = retLines[0].split(',').length - 1;
  check('1.2 returns.csv has 4 quarters', cols === 4, cols, 4);

  const stateRes = await admin('GET', 'state');
  check('1.3 state has 10 companies', stateRes.data.companies.length === 10, stateRes.data.companies.length, 10);
  check('1.4 state has 4 rounds', stateRes.data.settings.rounds === 4, stateRes.data.settings.rounds, 4);

  // ======== CHECK 2: Coordinators ========
  await admin('POST', 'teams', { names: ['AlphaTeam', 'BetaTeam'] });
  const genRes = await admin('POST', 'coordinators/generate', { count: 2 });
  check('2.1 2 coordinators created', genRes.data.created.length === 2, genRes.data.created.length, 2);
  const c1 = genRes.data.created[0];
  const c2 = genRes.data.created[1];
  check('2.2 C1 has code', !!c1.code, c1.code, 'non-empty');
  check('2.3 C1 has PIN', !!c1.pin, !!c1.pin, true);
  // Get full coordinator info from admin list
  const coordList = (await admin('GET', 'coordinators')).data.coordinators;
  const c1Full = coordList.find((x) => x.code === c1.code);
  const c2Full = coordList.find((x) => x.code === c2.code);
  check('2.4 C1 assigned 1 team', c1Full && c1Full.assignedTeams && c1Full.assignedTeams.length === 1, c1Full?.assignedTeams?.length, 1);

  // CSV download
  const csvRes = await call('GET', '/api/admin/coordinators.csv', { pin: ADMIN_PIN });
  check('2.5 CSV contains C1 PIN', csvRes.text.includes(c1.pin), csvRes.text.includes(c1.pin), true);
  check('2.6 CSV contains C2 PIN', csvRes.text.includes(c2.pin), csvRes.text.includes(c2.pin), true);

  // Login as coordinator 1
  const c1Login = await call('POST', '/api/auth/login', { body: { code: c1.code, pin: c1.pin } });
  check('2.7 C1 login succeeds', c1Login.status === 200, c1Login.status, 200);
  const c1Token = c1Login.data.token;

  // Coordinator cannot access admin routes
  const forbidden = await call('GET', '/api/admin/state', { token: c1Token });
  check('2.8 coordinator 403 on admin route', forbidden.status === 403, forbidden.status, 403);

  // ======== CHECK 3: Entry and NAV calculations ========
  const state = await admin('GET', 'state');
  const teams = state.data.teams;
  const teamId = c1Full.assignedTeams[0];
  const companies = state.data.companies;
  const cId = (name) => companies.find((c) => c.name === name).id;

  // Advance to investing phase (news -> investing)
  await advancePhase(); // news -> investing

  // 3.1 Rejections
  const rej05 = await call('POST', '/api/coord/entry', { token: c1Token, body: { teamId, round: 1, amounts: { [cId('ApexTech')]: '0.5' } } });
  check('3.1a 0.5 Cr rejected', rej05.status === 400 || rej05.status === 422, rej05.status, '400 or 422');
  const rejNeg = await call('POST', '/api/coord/entry', { token: c1Token, body: { teamId, round: 1, amounts: { [cId('ApexTech')]: '-5' } } });
  check('3.1b negative rejected', rejNeg.status === 400 || rejNeg.status === 422, rejNeg.status, '400 or 422');
  const rejOver = await call('POST', '/api/coord/entry', { token: c1Token, body: { teamId, round: 1, amounts: { [cId('ApexTech')]: '200' } } });
  check('3.1c over-budget rejected', rejOver.status === 422, rejOver.status, 422);

  // --- Q1 ---
  await advancePhase(); // investing -> entry
  const q1Res = await call('POST', '/api/coord/entry', { token: c1Token, body: {
    teamId, round: 1,
    amounts: { [cId('ApexTech')]: '25', [cId('MedHeal')]: '25', [cId('QuickMart')]: '25', [cId('FinBank')]: '25' }
  }});
  check('3.2 Q1 entry accepted', q1Res.status === 200, q1Res.status, 200);
  await advancePhase(); // entry -> revealed
  let board = (await call('GET', '/api/board')).data;
  const myTeam = () => board.teams.find((t) => t.id === teamId);
  const mt = myTeam();
  const q1nav = Number(mt.worth);
  check('3.3 Q1 NAV = 110.28', Math.abs(q1nav - 110.28) < 0.01, q1nav, 110.28);
  check('3.4 Q1 no penalty', !mt.penalized, mt.penalized, false);

  // 4.1 Q1 reveal: standings present
  check('4.1 Q1 standings visible', !board.standingsHidden, board.standingsHidden, false);

  // --- Q2 ---
  await advancePhase(); // revealed -> news (Q2)
  await advancePhase(); // news -> investing
  await advancePhase(); // investing -> entry
  const q2Res = await call('POST', '/api/coord/entry', { token: c1Token, body: {
    teamId, round: 2,
    amounts: { [cId('MedHeal')]: '20', [cId('QuickMart')]: '20', [cId('GreenFuel')]: '20', [cId('AgriGrow')]: '20' }
  }});
  check('3.5 Q2 entry accepted', q2Res.status === 200, q2Res.status, 200);
  await advancePhase(); // entry -> revealed
  board = (await call('GET', '/api/board')).data;
  const q2nav = Number(myTeam().worth);
  check('3.6 Q2 NAV = 112.38', Math.abs(q2nav - 112.38) < 0.01, q2nav, 112.38);
  check('3.7 Q2 no penalty', !myTeam().penalized, myTeam().penalized, false);
  // 4.2 Q2 reveal: standings present
  check('4.2 Q2 standings visible', !board.standingsHidden, board.standingsHidden, false);

  // --- Q3 ---
  await advancePhase(); // revealed -> news (Q3)
  await advancePhase(); // news -> investing
  await advancePhase(); // investing -> entry
  const q3Res = await call('POST', '/api/coord/entry', { token: c1Token, body: {
    teamId, round: 3,
    amounts: { [cId('MedHeal')]: '30', [cId('QuickMart')]: '30', [cId('GreenFuel')]: '30' }
  }});
  check('3.8 Q3 entry accepted', q3Res.status === 200, q3Res.status, 200);
  await advancePhase(); // entry -> revealed

  // Public board after Q3 reveal: hidden
  const boardRes = await call('GET', '/api/board');
  board = boardRes.data;
  check('4.3 Q3 standingsHidden=true', board.standingsHidden === true, board.standingsHidden, true);
  // Check raw text does NOT contain team's Q3 NAV values
  const rawQ3Board = boardRes.text;
  check('4.4 Q3 board has no ranks', board.teams.every((t) => t.rank === undefined), 'no ranks', true);
  check('4.5 Q3 board has no worth', board.teams.every((t) => t.worth === undefined), 'no worth', true);

  // Admin board still has full standings
  const admBoard = await admin('GET', 'board');
  const admMt = admBoard.data.teams.find((t) => t.id === teamId);
  check('4.6 admin board has ranks', admMt.rank !== undefined, !!admMt.rank, true);
  const q3nav = Number(admMt.worth);
  // Expected pre-penalty 107.43, penalty -15% -> 91.32
  check('3.9 Q3 NAV = 91.32 (penalized)', Math.abs(q3nav - 91.32) < 0.02, q3nav, 91.32);
  check('3.10 Q3 penalty applied', admMt.penalized === true, admMt.penalized, true);

  // --- Q4 ---
  await advancePhase(); // revealed -> news (Q4)
  await advancePhase(); // news -> investing

  // Buy 1 rumor
  const rumorRes = await call('POST', '/api/coord/rumor', { token: c1Token, body: { teamId, round: 4 } });
  check('3.11 rumor purchased', rumorRes.status === 200, rumorRes.status, 200);

  await advancePhase(); // investing -> entry
  const q4Res = await call('POST', '/api/coord/entry', { token: c1Token, body: {
    teamId, round: 4,
    amounts: { [cId('Velocity')]: '20', [cId('UrbanNest')]: '20', [cId('GreenFuel')]: '20', [cId('AgriGrow')]: '20' }
  }});
  check('3.12 Q4 entry accepted', q4Res.status === 200, q4Res.status, 200);
  await advancePhase(); // entry -> revealed

  // Q4 still hidden
  const boardQ4 = (await call('GET', '/api/board')).data;
  check('4.7 Q4 standingsHidden=true', boardQ4.standingsHidden === true, boardQ4.standingsHidden, true);

  const admBoardQ4 = await admin('GET', 'board');
  const admMtQ4 = admBoardQ4.data.teams.find((t) => t.id === teamId);
  const q4nav = Number(admMtQ4.worth);
  check('3.13 Q4 NAV = 94.32', Math.abs(q4nav - 94.32) < 0.02, q4nav, 94.32);
  check('3.14 Q4 no penalty (4 stocks)', !admMtQ4.penalized, admMtQ4.penalized, false);

  // Final reveal
  await advancePhase(); // -> final
  await admin('POST', 'final', { action: 'all' });
  const finalBoard = (await call('GET', '/api/board')).data;
  check('4.8 final standings visible', !finalBoard.standingsHidden && finalBoard.teams.every((t) => !t.hidden && t.worth !== undefined), 'visible', true);

  // 4.9 Coordinator sees only their team
  const coordCtx = await call('GET', '/api/coord/entry', { token: c1Token });
  check('4.9 coord sees only own team', coordCtx.data.teams.length === 1 && coordCtx.data.teams[0].id === teamId, coordCtx.data.teams.length, 1);

  // ======== CHECK 5: Restart test ========
  const savedToken = c1Token;
  await stopServer(server);
  server = await startServer();
  const afterRestart = await call('GET', '/api/coord/entry', { token: savedToken });
  check('5.1 token works after restart', afterRestart.status === 200, afterRestart.status, 200);
  const afterBoard = await admin('GET', 'state');
  check('5.2 state preserved (final phase)', afterBoard.data.phase === 'final', afterBoard.data.phase, 'final');

  // ======== Cleanup ========
  await stopServer(server);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  // ======== Summary ========
  console.log('\n========== SMOKE TEST SUMMARY ==========');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  for (const r of results) {
    if (!r.ok) console.log(`  FAIL: ${r.name} (actual=${r.actual}, expected=${r.expected})`);
  }
  console.log(`\n  ${passed} PASSED, ${failed} FAILED out of ${results.length} checks\n`);
  process.exit(failed > 0 ? 1 : 0);
} catch (e) {
  console.error('SMOKE TEST CRASHED:', e);
  process.exit(1);
}
