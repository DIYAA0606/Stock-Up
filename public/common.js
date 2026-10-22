export const $ = (s, el = document) => el.querySelector(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (s) => { const n = Number(s); return (s === null || s === undefined || isNaN(n)) ? 'â€“' : n.toFixed(2); };
export const pctText = (g) => {
  const p = Number(g);
  const t = Math.abs(p) < 1e-9 ? '0' : String(Math.round(Math.abs(p) * 1000) / 1000);
  return (p < 0 ? 'âˆ’' : '+') + t + '%';
};

// â”€â”€â”€ Token storage (Bearer-token auth, replaces x-pin header) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TOKEN_KEY = 'gtg-token';
const ROLE_KEY  = 'gtg-role';
const COORD_KEY = 'gtg-coordId';

export const getToken   = () => sessionStorage.getItem(TOKEN_KEY) || '';
export const setToken   = (t) => sessionStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ROLE_KEY);
  sessionStorage.removeItem(COORD_KEY);
};
export const getRole    = () => sessionStorage.getItem(ROLE_KEY) || '';
export const setRole    = (r) => sessionStorage.setItem(ROLE_KEY, r);
export const getCoordId = () => sessionStorage.getItem(COORD_KEY) || '';
export const setCoordId = (id) => sessionStorage.setItem(COORD_KEY, id);

// Legacy compat shims â€” any page still calling getPin()/setPin() will work
export const getPin   = getToken;
export const setPin   = setToken;
export const clearPin = clearToken;

// â”€â”€â”€ Fetch wrapper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // If the server says 401, wipe the stale token so the login gate re-shows
    if (res.status === 401) clearToken();
    const e = new Error(data.error || res.statusText);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

// â”€â”€â”€ Toast notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

/**
 * Login gate â€” resolves with role once a valid session token is stored.
 *
 * Supports two modes:
 *  - Admin: shows a single PIN field (code="ADMIN")
 *  - Coordinator: shows code + PIN fields
 *
 * @param {Element} root   Container element to render login form into
 * @param {object}  opts
 * @param {string}  opts.title    Page title shown in the form
 * @param {string[]} opts.allow   Allowed roles, e.g. ['admin'] or ['coordinator','admin']
 * @param {boolean} [opts.coordinator]  Show coordinator code + PIN form
 */
export async function gate(root, { title, allow, coordinator = false }) {
  // If token already stored, verify it's still valid
  if (getToken()) {
    try {
      // Verify by hitting an auth-gated endpoint
      const probe = coordinator
        ? await api('/api/coord/entry')
        : await api('/api/admin/state');
      const role = getRole();
      if (allow.includes(role)) return role;
    } catch {}
    clearToken();
  }

  const showCoordFields = coordinator || allow.every((r) => r === 'coordinator');

  return new Promise((resolve) => {
    if (showCoordFields) {
      root.innerHTML = `<form class="gate" id="login-form">
        <h1>${esc(title)}</h1>
        <label for="coord-code">Coordinator Code</label>
        <input id="coord-code" type="text" placeholder="e.g. C01" autocomplete="off" autofocus>
        <label for="coord-pin">PIN</label>
        <div class="row"><input id="coord-pin" type="password" inputmode="numeric" autocomplete="off"><button class="btn" id="login-btn">Unlock</button></div>
        <p class="muted" id="msg" role="alert"></p>
      </form>`;
    } else {
      root.innerHTML = `<form class="gate" id="login-form">
        <h1>${esc(title)}</h1>
        <label for="admin-pin">Admin PIN</label>
        <div class="row"><input id="admin-pin" type="password" inputmode="numeric" autocomplete="off" autofocus><button class="btn" id="login-btn">Unlock</button></div>
        <p class="muted" id="msg" role="alert"></p>
      </form>`;
    }

    root.querySelector('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msgEl = root.querySelector('#msg');
      msgEl.textContent = '';

      let code, pin;
      if (showCoordFields) {
        code = (root.querySelector('#coord-code')?.value || '').trim().toUpperCase() || 'C01';
        pin  = (root.querySelector('#coord-pin')?.value  || '').trim();
        if (!pin) { msgEl.textContent = 'Please enter your PIN.'; return; }
      } else {
        code = 'ADMIN';
        pin  = (root.querySelector('#admin-pin')?.value || '').trim();
        if (!pin) { msgEl.textContent = 'Please enter the admin PIN.'; return; }
      }

      try {
        const r = await api('/api/auth/login', { method: 'POST', body: { code, pin } });
        if (!allow.includes(r.role)) throw new Error('This account cannot open this page.');
        setToken(r.token);
        setRole(r.role);
        if (r.coordId) setCoordId(r.coordId);
        resolve(r.role);
      } catch (err) {
        clearToken();
        msgEl.textContent = err.message;
      }
    });
  });
}

