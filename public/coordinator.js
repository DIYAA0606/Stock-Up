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
  if (ctx.noTeamAssigned || !ctx.teams || ctx.teams.length === 0) {
    root.innerHTML = `<div class="shell" style="max-width:560px;margin:50px auto;text-align:center;">
      <div class="panel stack" style="padding:32px;">
        <h2 style="margin:0 0 16px 0;">Coordinator Portal</h2>
        <div class="note warn" style="font-size:1.15rem;padding:24px;border-radius:8px;">No team assigned, contact the organizer</div>
        <div style="margin-top:20px;">
          <button class="btn dark" id="logoutBtn">Log out</button>
        </div>
      </div>
    </div>`;
    $('#logoutBtn').addEventListener('click', () => { clearToken(); location.reload(); });
    return;
  }
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
  $('#phase').textContent = `Quarter ${ctx.round}${ctx.roundName ? ` • ${ctx.roundName}` : ` • ${ctx.label}`}`;
  const o = $('#open');
  o.textContent = ctx.writable ? 'Entry open' : 'Entry closed';
  o.className = 'badge ' + (ctx.writable ? 'open' : 'closed');
}

function renderTeams() {
  const entered = ctx.teams.filter((t) => t.entered).length;
  $('#progress').textContent = `${entered} of ${ctx.teams.length} assigned chits entered for quarter ${ctx.selectedRound}`;
  const list = visibleTeams();
  $('#teams').innerHTML = list.length
    ? list.map((t) => `<button class="team ${t.id === sel ? 'sel' : ''}" data-id="${t.id}"><span>${esc(t.name)}<br><span class="cap num">Available ${fmt(t.capitalStart)} Cr${t.rumorCount ? ` · ${t.rumorCount} rumor${t.rumorCount > 1 ? 's' : ''}` : ''}</span></span>${t.entered ? '<span class="tick" aria-label="entered">✓</span>' : ''}</button>`).join('')
    : `<div class="muted" style="padding:12px;line-height:1.4">${ctx.teams.length === 0 ? 'No teams found in this event yet.<br><br>Please add teams in the <a href="/admin.html" style="color:var(--accent);text-decoration:underline">Admin Panel</a> (Teams tab).' : `No team matches "${esc(filter)}".`}</div>`;
  for (const b of $('#teams').querySelectorAll('.team')) b.addEventListener('click', () => choose(b.dataset.id));
}

function totals() {
  const t = ctx.teams.find((x) => x.id === sel);
  if (!t) return { t: null, invested: 0, count: 0, cap: 0, rumorFees: 0, investable: 0, left: 0, bad: false, over: false, belowMin: [] };
  let invested = 0;
  let count = 0;
  let bad = false;
  const belowMin = [];
  const minPerStock = Number(ctx.minPerStock || 1);

  for (const [cid, v] of Object.entries(draft)) {
    if (String(v).trim() === '') continue;
    const n = num(v);
    if (Number.isNaN(n) || n < 0) { bad = true; continue; }
    if (n > 0) {
      if (n < minPerStock) {
        const co = ctx.companies.find((c) => c.id === cid);
        belowMin.push(co ? co.name : cid);
      }
      invested += n;
      count++;
    }
  }

  const cap = Number(t.capitalStart);
  const rumorFees = Number(t.rumorFees || 0);
  const investable = cap - rumorFees;
  const left = investable - invested;
  return { t, invested, count, cap, rumorFees, investable, left, bad, over: left < -1e-9, belowMin };
}

function renderForm() {
  const box = $('#form');
  if (!sel) {
    box.innerHTML = ctx.teams.length === 0
      ? `<div style="padding:16px"><p class="muted">No teams are available in this event yet.</p><p class="muted">Go to the <a href="/admin.html" style="color:var(--accent);text-decoration:underline">Admin Panel</a> &rarr; <b>Teams</b> tab to add or import your team list.</p></div>`
      : `<p class="muted">Pick one of your assigned teams on the left. Type part of the name and press Enter. In the amounts, Enter moves to the next stock and Ctrl+Enter jumps straight to review.</p>`;
    return;
  }
  const { t } = totals();
  if (!t) {
    box.innerHTML = `<p class="muted">Team not found in your assigned list.</p>`;
    return;
  }
  const dis = ctx.writable ? '' : 'disabled';
  box.innerHTML = `
    <h2 style="margin:0">${esc(t.name)} <span class="muted" style="font-size:16px;font-weight:400">— Quarter ${ctx.selectedRound}${ctx.roundName ? ` (${esc(ctx.roundName)})` : ''}</span></h2>
    <div class="muted num" style="margin-top:4px">Quarter Opening Capital: <b style="color:var(--text)">${fmt(t.capitalStart)} Cr</b>${t.entered ? ' · chit already entered, saving replaces it' : ''}</div>
    
    <div class="inline" style="gap:12px;margin:10px 0;align-items:center;background:var(--panel2);padding:10px 14px;border-radius:6px;border:1px solid var(--line)">
      <span class="pill" style="font-size:13px">Rumors bought: <b id="rCount">${t.rumorCount || 0}</b> (${fmt(t.rumorFees || 0)} Cr sunk)</span>
      <button class="btn small dark" id="buyRumorBtn" ${dis}>+ Buy rumor (5 Cr)</button>
      <span class="muted" style="margin-left:auto;font-size:13px">Investable cash: <b id="invCash" style="color:var(--text)">${fmt(t.investableCash || t.capitalStart)} Cr</b></span>
    </div>

    ${ctx.writable ? '' : '<div class="note bad">Entry is closed for this round. Waiting for admin.</div>'}
    <div class="alloc">${ctx.companies.map((c) => `<div><label for="a_${c.id}"><span>${esc(c.name)}</span></label><input id="a_${c.id}" data-c="${c.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(draft[c.id] ?? '')}" ${dis}></div>`).join('')}</div>
    <div id="notes"></div>
    <div class="summary num">
      <div><div class="muted">Invested</div><div class="v" id="inv"></div></div>
      <div><div class="muted">Rumor fees</div><div class="v" id="rf">${fmt(t.rumorFees || 0)} Cr</div></div>
      <div><div class="muted">Stays as cash</div><div class="v" id="cash"></div></div>
      <div style="margin-left:auto" class="inline">
        <button class="btn ghost" id="clear" ${dis}>Clear</button>
        <button class="btn" id="review" ${dis}>Review chit</button>
      </div>
    </div>
    ${t.results && t.results.length ? `
    <div style="margin-top:24px;border-top:1px solid var(--line);padding-top:16px;">
      <h3 style="margin:0 0 12px 0;">Quarter Results for ${esc(t.name)}</h3>
      ${t.results.map((r) => `
        <div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px;">
          <div class="inline" style="justify-content:space-between;margin-bottom:8px;">
            <b>Quarter ${r.quarter}${r.roundName ? `: ${esc(r.roundName)}` : ''}</b>
            <span class="pill" style="background:#123a17;color:#9be59b">Closing NAV: ${fmt(r.newNav)} Cr</span>
          </div>
          <table class="grid" style="width:100%;font-size:13px;margin-bottom:8px;">
            <thead>
              <tr><th>Stock</th><th class="num">Allocated</th><th class="num">Change %</th><th class="num">Exit Value</th></tr>
            </thead>
            <tbody>
              ${r.stocks.map((s) => `
                <tr>
                  <td>${esc(s.name)}</td>
                  <td class="num">${fmt(s.allocated)} Cr</td>
                  <td class="num" style="color:${s.changePct >= 0 ? '#4ade80' : '#f87171'}">${s.changePct > 0 ? '+' : ''}${s.changePct}%</td>
                  <td class="num"><b>${fmt(s.exitValue)} Cr</b></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="summary num" style="font-size:12px;display:flex;gap:12px;flex-wrap:wrap;">
            <div><span class="muted">Rumor fees:</span> ${fmt(r.rumorFees)} Cr</div>
            <div><span class="muted">Cash left:</span> ${fmt(r.cash)} Cr</div>
            <div><span class="muted">Stocks:</span> ${r.distinctCount}</div>
            <div><span class="muted">Penalty:</span> <span style="color:${r.penalized ? '#f87171' : 'inherit'}">${r.penalized ? `-${fmt(r.penalty)} Cr` : 'None'}</span></div>
            <div><span class="muted">NAV:</span> <b>${fmt(r.newNav)} Cr</b></div>
            <div><span class="muted">Next Q Cash:</span> <b>${fmt(r.nextQuarterCash)} Cr</b></div>
          </div>
        </div>
      `).join('')}
    </div>` : ''}`;

  $('#buyRumorBtn')?.addEventListener('click', async () => {
    if (!confirm(`Buy a rumor for ${t.name}?\n\nThis will immediately and permanently deduct 5 Cr from this quarter's available cash (sunk cost).`)) return;
    try {
      const res = await api('/api/coord/rumor', {
        method: 'POST',
        body: { teamId: sel, round: ctx.selectedRound },
      });
      toast(`Rumor purchased for ${t.name}! 5 Cr deducted.`, 'ok');
      await load(true);
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

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
  const { invested, count, left, bad, over, belowMin, rumorFees } = totals();
  $('#inv').textContent = fmt(invested) + ' Cr';
  const cash = $('#cash');
  cash.textContent = fmt(left) + ' Cr';
  cash.className = 'v' + (over ? ' over' : '');
  const notes = [];
  if (bad) notes.push(['bad', 'One of the amounts is not a valid positive number.']);
  if (belowMin.length) notes.push(['bad', `Amount for ${belowMin.join(', ')} must be at least ${ctx.minPerStock || 1} Cr (or 0).`]);
  if (over) notes.push(['bad', `This chit is ${fmt(-left)} Cr over the available investable amount.`]);
  if (!over && !bad && count < 4) {
    notes.push(['bad', `Under 4 stocks (${count} chosen): 15% penalty applies`]);
  }
  $('#notes').innerHTML = notes.map(([k, m]) => `<div class="note ${k}" style="${k === 'bad' && m.includes('penalty') ? 'background:#3d1414;color:#ff8585;border:1px solid #752222;font-weight:700' : ''}">${esc(m)}</div>`).join('');
  $('#review').disabled = !ctx.writable || bad || over || belowMin.length > 0;
}

function review() {
  const { t, invested, left, bad, over, belowMin, count, rumorFees } = totals();
  if (!ctx.writable || bad || over || belowMin.length > 0 || !t) return;
  const lines = ctx.companies.filter((c) => num(draft[c.id]) > 0);
  $('#modal').innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <h2 id="mt">Read this back to the team</h2>
    <div><b>${esc(t.name)}</b> — Quarter ${ctx.selectedRound}${ctx.roundName ? ` (${esc(ctx.roundName)})` : ''}</div>
    <table class="num">${lines.length ? lines.map((c) => `<tr><td>${esc(c.name)}</td><td>${fmt(num(draft[c.id]))} Cr</td></tr>`).join('') : '<tr><td>No investments (all cash)</td><td></td></tr>'}
    ${rumorFees > 0 ? `<tr><td>Rumor fees (sunk cost)</td><td>${fmt(rumorFees)} Cr</td></tr>` : ''}
    <tr><td><b>Invested</b></td><td><b>${fmt(invested)} Cr</b></td></tr>
    <tr><td>Stays as cash</td><td>${fmt(left)} Cr</td></tr></table>
    ${count < 4 ? `<div class="note bad" style="margin:12px 0;background:#3d1414;color:#ff8585;border:1px solid #752222;font-weight:700">⚠️ Under 4 stocks (${count} chosen): 15% penalty will be deducted from closing NAV.</div>` : ''}
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
    toast(`Saved chit: ${r.team || 'team'} — ${fmt(r.invested || 0)} Cr invested`, 'ok');
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
