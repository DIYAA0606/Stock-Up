export const $ = (s, el = document) => el.querySelector(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (s) => { const n = Number(s); return (s === null || s === undefined || isNaN(n)) ? '–' : n.toFixed(2); };
export const pctText = (g) => {
  const p = Number(g) * 100;
  const t = Math.abs(p) < 1e-9 ? '0' : String(Math.round(Math.abs(p) * 1000) / 1000);
  return (p < 0 ? '−' : '+') + t + '%';
};

const KEY = 'gtg-pin';
export const getPin = () => sessionStorage.getItem(KEY) || '';
export const setPin = (p) => sessionStorage.setItem(KEY, p);
export const clearPin = () => sessionStorage.removeItem(KEY);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-pin': getPin() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || res.statusText);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

let toastTimer;
export function toast(msg, kind = '') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === 'err' ? 6000 : 2500);
}

/** mm:ss until phaseEndsAt, using the server clock so laptops with skewed clocks agree. */
export function makeClock() {
  let offset = 0;
  return {
    sync(serverNow) { offset = serverNow - Date.now(); },
    left(endsAt) {
      if (!endsAt) return null;
      return Math.max(0, Math.round((endsAt - (Date.now() + offset)) / 1000));
    },
  };
}
export const mmss = (s) => (s === null ? '' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);

/** PIN gate: resolves with the role once a valid PIN is stored. */
export async function gate(root, { title, allow }) {
  if (getPin()) {
    try {
      const r = await api('/api/login', { method: 'POST', body: { pin: getPin() } });
      if (allow.includes(r.role)) return r.role;
    } catch {}
    clearPin();
  }
  return new Promise((resolve) => {
    root.innerHTML = `<form class="gate"><h1>${esc(title)}</h1>
      <label for="pin">PIN</label>
      <div class="row"><input id="pin" type="password" inputmode="numeric" autocomplete="off" autofocus><button class="btn">Unlock</button></div>
      <p class="muted" id="msg" role="alert"></p></form>`;
    root.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = root.querySelector('#pin').value.trim();
      if (!raw) {
        root.querySelector('#msg').textContent = 'Please enter a PIN.';
        return;
      }
      setPin(raw);
      try {
        const r = await api('/api/login', { method: 'POST', body: { pin: getPin() } });
        if (!allow.includes(r.role)) throw new Error('This PIN cannot open this page.');
        resolve(r.role);
      } catch (err) {
        clearPin();
        root.querySelector('#msg').textContent = err.message;
      }
    });
  });
}
