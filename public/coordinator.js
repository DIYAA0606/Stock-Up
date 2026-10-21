import { $, esc, fmt, api, toast, gate, makeClock, mmss, clearToken, getCoordId } from '/common.js';

const root = document.getElementById('root');
const clock = makeClock();
const role = await gate(root, { title: 'Coordinator Portal', allow: ['coordinator', 'admin'], coordinator: true });

let ctx = null;
let sel = null; // selected team id
let filter = '';
let draft = {}; // companyId -> string

const num = (s) => {
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : NaN;
};

async function load(keepDraft = false) {
  ctx = await api('/api/coord/entry');
  if (sel && !ctx.teams.some((t) => t.id === sel)) sel = null;
  if (!keepDraft) draftFromTeam();
  clock.sync(ctx.serverNow);
}

function draftFromTeam() {
  const t = ctx.teams.find((x) => x.id === sel);
  draft = t ? { ...t.amounts } : {};
}

function shell() {
  const coordCode = getCoordId();
  root.innerHTML = `<div class="shell">
    <div class="bar">
      <div>
        <span class="brand">Guess the <b>Growth</b></span>
        <span class="muted">coordinator portal</span>
        ${coordCode ? `<span class="pill" style="margin-left:8px">${esc(coordCode)}</span>` : ''}
      </div>
      <div class="inline">
        <span id="phase"></span>
        <span class="badge" id="open"></span>
        <b class="num" id="timer"></b>
        <button class="btn dark small" id="logoutBtn" style="margin-left:12px">Log out</button>
      </div>
    </div>
    <div class="entry-grid">
      <section aria-label="Assigned Teams">
        <label for="filter">Find assigned team (type, then Enter)</label>
        <input id="filter" type="text" autocomplete="off" placeholder="Search team name...">
        <div class="muted" id="progress" style="margin-top:8px"></div>
        <div class="teams" id="teams"></div>
        <button class="btn dark small" id="nextPending" style="margin-top:8px">Go to next team without a chit</button>
      </section>
      <section class="panel" id="form" aria-live="polite"></section>
    </div>
  </div>
  <div id="modal"></div>`;

  $('#logoutBtn').addEventListener('click', () => {
    clearToken();
    location.reload();
  });
  $('#filter').addEventListener('input', (e) => { filter = e.target.value; renderTeams(); });
  $('#filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = visibleTeams()[0];
      if (first) choose(first.id);
    }
  });
  $('#nextPending').addEventListener('click', goNextPending);
}

const visibleTeams = () => ctx.teams.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));

function renderBar() {
  $('#phase').textContent = `Round ${ctx.round} · ${ctx.label}`;
  const o = $('#open');
  o.textContent = ctx.writable ? 'Entry open' : 'Entry closed';
  o.className = 'badge ' + (ctx.writable ? 'open' : 'closed');
}

function renderTeams() {
  const entered = ctx.teams.filter((t) => t.entered).length;
  $('#progress').textContent = `${entered} of ${ctx.teams.length} assigned chits entered for round ${ctx.selectedRound}`;
  const list = visibleTeams();
  $('#teams').innerHTML = list.length
    ? list.map((t) => `<button class="team ${t.id === sel ? 'sel' : ''}" data-id="${t.id}"><span>${esc(t.name)}<br><span class="cap num">Available ${fmt(t.capitalStart)} Cr</span></span>${t.entered ? '<span class="tick" aria-label="entered">✓</span>' : ''}</button>`).join('')
    : `<div class="muted">${ctx.teams.length === 0 ? 'No teams assigned to you yet.' : `No team matches "${esc(filter)}".`}</div>`;
  for (const b of $('#teams').querySelectorAll('.team')) b.addEventListener('click', () => choose(b.dataset.id));
}

function totals() {
  const t = ctx.teams.find((x) => x.id === sel);
  if (!t) return { t: null, invested: 0, count: 0, cap: 0, left: 0, bad: false, over: false };
  let invested = 0;
  let count = 0;
  let bad = false;
  for (const v of Object.values(draft)) {
    if (String(v).trim() === '') continue;
    const n = num(v);
    if (Number.isNaN(n) || n < 0) { bad = true; continue; }
    if (n > 0) { invested += n; count++; }
  }
  const cap = Number(t.capitalStart);
  const left = cap - invested;
  return { t, invested, count, cap, left, bad, over: left < -1e-9 };
}

function renderForm() {
  const box = $('#form');
  if (!sel) {
    box.innerHTML = `<p class="muted">Pick one of your assigned teams on the left. Type part of the name and press Enter. In the amounts, Enter moves to the next company and Ctrl+Enter jumps straight to the review.</p>`;
    return;
  }
  const { t } = totals();
  if (!t) {
    box.innerHTML = `<p class="muted">Team not found in your assigned list.</p>`;
    return;
  }
  const dis = ctx.writable ? '' : 'disabled';
  box.innerHTML = `
    <h2 style="margin:0">${esc(t.name)} <span class="muted" style="font-size:16px;font-weight:400">· round ${ctx.selectedRound}</span></h2>
    <div class="muted num">Available to invest: <b style="color:var(--text)">${fmt(t.capitalStart)} Cr</b>${t.entered ? ' · chit already entered, saving replaces it' : ''}</div>
    ${ctx.writable ? '' : '<div class="note bad">Entry is closed for this round. Waiting for admin.</div>'}
    <div class="alloc">${ctx.companies.map((c) => `<div><label for="a_${c.id}"><span>${esc(c.name)}</span></label><input id="a_${c.id}" data-c="${c.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(draft[c.id] ?? '')}" ${dis}></div>`).join('')}</div>
    <div id="notes"></div>
    <div class="summary num">
      <div><div class="muted">Invested</div><div class="v" id="inv"></div></div>
      <div><div class="muted">Stays as cash</div><div class="v" id="cash"></div></div>
      <div style="margin-left:auto" class="inline">
        <button class="btn ghost" id="clear" ${dis}>Clear</button>
        <button class="btn" id="review" ${dis}>Review chit</button>
      </div>
    </div>`;
  const inputs = [...box.querySelectorAll('.alloc input')];
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', () => { draft[inp.dataset.c] = inp.value; inp.classList.toggle('has', num(inp.value) > 0); refreshTotals(); });
    inp.classList.toggle('has', num(inp.value) > 0);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || i === inputs.length - 1) review();
        else if (i < inputs.length - 1) inputs[i + 1].focus();
      }
    });
    inp.addEventListener('focus', () => inp.select());
  });
  $('#clear').addEventListener('click', () => { draft = {}; renderForm(); inputs[0]?.focus(); });
  $('#review').addEventListener('click', review);
  refreshTotals();
}

function refreshTotals() {
  const { invested, count, left, bad, over } = totals();
  $('#inv').textContent = fmt(invested) + ' Cr';
  const cash = $('#cash');
  cash.textContent = fmt(left) + ' Cr';
  cash.className = 'v' + (over ? ' over' : '');
  const notes = [];
  if (bad) notes.push(['bad', 'One of the amounts is not a valid positive number.']);
  if (over) notes.push(['bad', `This chit is ${fmt(-left)} Cr over the available amount.`]);
  if (!over && !bad && count > 0 && count < 4) notes.push(['warn', `Only ${count} compan${count === 1 ? 'y' : 'ies'} chosen. The rules ask for at least 4.`]);
  $('#notes').innerHTML = notes.map(([k, m]) => `<div class="note ${k}">${esc(m)}</div>`).join('');
  $('#review').disabled = !ctx.writable || bad || over;
}

function review() {
  const { t, invested, left, bad, over } = totals();
  if (!ctx.writable || bad || over || !t) return;
  const lines = ctx.companies.filter((c) => num(draft[c.id]) > 0);
  $('#modal').innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <h2 id="mt">Read this back to the team</h2>
    <div><b>${esc(t.name)}</b> · round ${ctx.selectedRound}</div>
    <table class="num">${lines.length ? lines.map((c) => `<tr><td>${esc(c.name)}</td><td>${fmt(num(draft[c.id]))} Cr</td></tr>`).join('') : '<tr><td>No investments (all cash)</td><td></td></tr>'}
    <tr><td><b>Invested</b></td><td><b>${fmt(invested)} Cr</b></td></tr>
    <tr><td>Stays as cash</td><td>${fmt(left)} Cr</td></tr></table>
    <div class="inline" style="justify-content:flex-end">
      <button class="btn ghost" id="mBack">Go back and edit</button>
      <button class="btn" id="mSave">Save chit</button>
    </div>
  </div></div>`;
  $('#mSave').focus();
  $('#mBack').addEventListener('click', closeModal);
  $('#mSave').addEventListener('click', save);
  document.addEventListener('keydown', escClose);
}

const escClose = (e) => { if (e.key === 'Escape') closeModal(); };
function closeModal() { $('#modal').innerHTML = ''; document.removeEventListener('keydown', escClose); }

async function save() {
  const amounts = {};
  for (const c of ctx.companies) if (num(draft[c.id]) > 0) amounts[c.id] = String(draft[c.id]).trim();
  const btn = $('#mSave');
  btn.disabled = true;
  try {
    const r = await api('/api/coord/entry', { method: 'POST', body: { teamId: sel, round: ctx.selectedRound, amounts } });
    closeModal();
    toast(`Saved chit: ${r.team || 'team'} · ${fmt(r.invested || 0)} Cr invested`, 'ok');
    const saved = sel;
    await load();
    sel = null;
    draftFromTeam();
    render();
    const nxt = ctx.teams.find((t) => !t.entered && t.id !== saved);
    if (nxt) $('#filter').focus();
    else toast('All your assigned teams have chits for this round!', 'ok');
    $('#filter').value = '';
    filter = '';
    renderTeams();
  } catch (e) {
    closeModal();
    toast(e.message, 'err');
    btn.disabled = false;
    if (e.status === 409) { await load(true); render(); }
  }
}

function choose(id) {
  sel = id;
  draftFromTeam();
  renderTeams();
  renderForm();
  $('#form input')?.focus();
}

function goNextPending() {
  const nxt = ctx.teams.find((t) => !t.entered);
  if (nxt) choose(nxt.id);
  else toast('All your assigned teams have chits for this round!', 'ok');
}

function render() { renderBar(); renderTeams(); renderForm(); }

shell();
await load();
render();
$('#filter').focus();

// Periodic sync every 3s
setInterval(async () => {
  try {
    const fresh = await api('/api/coord/entry');
    clock.sync(fresh.serverNow);
    const wasWritable = ctx.writable;
    const roundChanged = fresh.round !== ctx.round;
    const phaseChanged = fresh.phase !== ctx.phase || roundChanged;
    ctx = fresh;
    renderBar();
    renderTeams();
    if (roundChanged || wasWritable !== ctx.writable) {
      if (roundChanged || !sel) { sel = null; draft = {}; }
      renderForm();
      if (sel && !ctx.writable) toast('Entry just closed. Your typed amounts were not saved.', 'err');
    } else if (phaseChanged) renderBar();
  } catch (e) {
    if (e.status === 401) location.reload();
  }
}, 3000);

setInterval(() => {
  const l = clock.left(ctx?.phaseEndsAt);
  const el = document.getElementById('timer');
  if (el) el.textContent = mmss(l);
}, 1000);
