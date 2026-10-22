// Zero-dependency HTTP server: static pages + JSON API.
// Works on one laptop (npm start) and on Vercel Serverless (api/index.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import * as app from './app.js';
import { signToken, verifyToken, hashPin, checkPin } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ─── Body reader ─────────────────────────────────────────────────────────────
function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try   { return Promise.resolve(JSON.parse(req.body)); }
      catch { return Promise.reject(new app.HttpError(400, 'Body is not valid JSON')); }
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new app.HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new app.HttpError(400, 'Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Token helper ────────────────────────────────────────────────────────────
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

// ─── Random PIN helper ───────────────────────────────────────────────────────
const randPin6 = () => String(crypto.randomInt(100000, 999999));

// ─── Request handler factory ────────────────────────────────────────────────
export function createRequestHandler(store) {
  const json = (res, status, obj, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(JSON.stringify(obj));
  };

  async function need(req, res, ...roles) {
    const rawIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?');
    const ip = rawIp.split(',')[0].trim();

    const blocked = await store.isRateLimited(`ip:${ip}`, 15, 60);
    if (blocked) throw new app.HttpError(429, 'Too many failed attempts. Wait a minute.');

    const token = extractToken(req);
    let payload;

    if (token) {
      try {
        payload = verifyToken(token);
      } catch (e) {
        await store.recordFailAndCheck(`ip:${ip}`, 15, 60);
        throw new app.HttpError(e.status || 401, e.message || 'Invalid or expired token');
      }
    } else {
      // Legacy PIN fallback (for tests, LAN mode, curl scripts)
      const pin = req.headers['x-pin'];
      if (pin) {
        const st = await store.load();
        if (st.settings.adminPinHash && checkPin(pin, st.settings.adminPinHash)) {
          payload = { role: 'admin', coordId: 'ADMIN' };
        } else if (st.settings.coordinatorPinHash && checkPin(pin, st.settings.coordinatorPinHash)) {
          payload = { role: 'coordinator', coordId: 'legacy' };
        } else {
          const coords = await store.getCoordinators();
          const coord = coords.find((c) => c.enabled && checkPin(pin, c.pinHash));
          if (coord) {
            payload = { role: 'coordinator', coordId: coord.id };
          }
        }
      }
    }

    if (!payload) {
      await store.recordFailAndCheck(`ip:${ip}`, 15, 60);
      throw new app.HttpError(401, 'Missing or invalid token. Please log in.');
    }

    if (!roles.includes(payload.role)) throw new app.HttpError(403, 'Not allowed for your role');
    return payload;
  }

  /**
   * Save state, write audit line, optionally take a backup snapshot.
   */
  async function commit(st, who, action, detail = {}, { backup } = {}) {
    await store.save(st);
    await store.audit(who, action, detail);
    if (backup) await store.backup(backup);
  }

  // ─── Main API router ──────────────────────────────────────────────────────
  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname;

    // ── Public board (no auth — projector safe) ───────────────────────────
    if (m === 'GET' && p === '/api/board') {
      const cached = await store.getBoardCache();
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 's-maxage=2, stale-while-revalidate=5',
          'X-Cache': 'HIT',
        });
        return res.end(cached);
      }
      const st = await store.load();
      const board = app.buildBoard(st);
      const boardJson = JSON.stringify(board);
      await store.setBoardCache(boardJson, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 's-maxage=2, stale-while-revalidate=5',
      });
      return res.end(boardJson);
    }

    // ── Login: POST /api/auth/login or /api/login { code, pin } ───────────
    if (m === 'POST' && (p === '/api/auth/login' || p === '/api/login')) {
      const body = await readBody(req);
      let code = String(body.code || '').trim().toUpperCase();
      const pin  = String(body.pin  || '').trim();
      const rawIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?');
      const ip = rawIp.split(',')[0].trim();

      // Legacy fallback: if code omitted, detect role from PIN
      if (!code && pin) {
        const st = await store.load();
        if (st.settings.adminPinHash && checkPin(pin, st.settings.adminPinHash)) {
          code = 'ADMIN';
        } else if (st.settings.coordinatorPinHash && checkPin(pin, st.settings.coordinatorPinHash)) {
          const token = signToken({ role: 'coordinator', coordId: 'legacy' });
          await store.audit('LEGACY_COORD', 'login', { ip });
          return json(res, 200, { token, role: 'coordinator', coordId: 'legacy' });
        }
      }

      const blockedIp   = await store.isRateLimited(`ip:${ip}`, 15, 60);
      const blockedCode = await store.isRateLimited(`code:${code}`, 10, 60);
      if (blockedIp || blockedCode) throw new app.HttpError(429, 'Too many failed attempts. Try again later.');

      if (code === 'ADMIN') {
        const st = await store.load();
        const valid = checkPin(pin, st.settings.adminPinHash);
        if (!valid) {
          await store.recordFailAndCheck(`ip:${ip}`, 15, 60);
          await store.recordFailAndCheck(`code:ADMIN`, 10, 60);
          throw new app.HttpError(401, 'Invalid admin PIN');
        }
        const token = signToken({ role: 'admin', coordId: 'ADMIN' });
        await store.audit('ADMIN', 'login', { ip });
        return json(res, 200, { token, role: 'admin' });
      }

      // Coordinator login
      const coords = await store.getCoordinators();
      const coord = coords.find((c) => c.code.toUpperCase() === code);
      if (!coord || !coord.enabled) {
        const st = await store.load();
        if (st.settings.coordinatorPinHash && checkPin(pin, st.settings.coordinatorPinHash)) {
          const token = signToken({ role: 'coordinator', coordId: code || 'legacy' });
          await store.audit(code || 'LEGACY_COORD', 'login', { ip });
          return json(res, 200, { token, role: 'coordinator', coordId: code || 'legacy' });
        }
        if (st.settings.adminPinHash && checkPin(pin, st.settings.adminPinHash)) {
          const token = signToken({ role: 'admin', coordId: 'ADMIN' });
          await store.audit('ADMIN', 'login', { ip });
          return json(res, 200, { token, role: 'admin' });
        }
        await store.recordFailAndCheck(`ip:${ip}`, 15, 60);
        await store.recordFailAndCheck(`code:${code}`, 10, 60);
        throw new app.HttpError(401, 'Invalid coordinator code or PIN');
      }
      const validCoord = checkPin(pin, coord.pinHash);
      if (!validCoord) {
        const st = await store.load();
        if (st.settings.coordinatorPinHash && checkPin(pin, st.settings.coordinatorPinHash)) {
          const token = signToken({ role: 'coordinator', coordId: coord.id });
          await store.audit(coord.code, 'login', { ip });
          return json(res, 200, { token, role: 'coordinator', coordId: coord.id });
        }
        if (st.settings.adminPinHash && checkPin(pin, st.settings.adminPinHash)) {
          const token = signToken({ role: 'admin', coordId: 'ADMIN' });
          await store.audit('ADMIN', 'login', { ip });
          return json(res, 200, { token, role: 'admin' });
        }
        await store.recordFailAndCheck(`ip:${ip}`, 15, 60);
        await store.recordFailAndCheck(`code:${code}`, 10, 60);
        throw new app.HttpError(401, 'Invalid coordinator code or PIN');
      }
      const token = signToken({ role: 'coordinator', coordId: coord.id });
      await store.audit(coord.code, 'login', { ip });
      return json(res, 200, { token, role: 'coordinator', coordId: coord.id });
    }

    // ── Coordinator entry context: GET /api/coord/entry or /api/entry ──
    if (m === 'GET' && (p === '/api/coord/entry' || p === '/api/entry')) {
      const payload = await need(req, res, 'admin', 'coordinator');
      const st = await store.load();

      let teams;
      if (payload.role === 'admin' || payload.coordId === 'legacy') {
        teams = st.teams;
      } else {
        const coord = await store.getCoordinator(payload.coordId);
        if (coord && !coord.enabled) throw new app.HttpError(403, 'Coordinator account disabled');
        if (coord && coord.assignedTeams && coord.assignedTeams.length > 0) {
          const allowed = new Set(coord.assignedTeams);
          teams = st.teams.filter((t) => allowed.has(t.id));
        } else {
          teams = [];
        }
      }

      const roundParam = url.searchParams.get('round');
      return json(res, 200, app.entryContext(st, payload.role, roundParam, teams));
    }

    // ── Coordinator entry submit: POST /api/coord/entry or /api/entry ──
    if (m === 'POST' && (p === '/api/coord/entry' || p === '/api/entry')) {
      const payload = await need(req, res, 'admin', 'coordinator');
      const b = await readBody(req);
      const st = await store.load();

      if (payload.role === 'coordinator' && payload.coordId !== 'legacy') {
        const coord = await store.getCoordinator(payload.coordId);
        if (coord && !coord.enabled) throw new app.HttpError(403, 'Coordinator account disabled');
        if (!coord || !coord.assignedTeams || !coord.assignedTeams.includes(b.teamId)) {
          throw new app.HttpError(403, 'You are not assigned to this team');
        }
      }

      const round = Number(b.round);
      const before = (st.allocations[b.teamId] || {})[round];

      if (before && JSON.stringify(before.amounts) === JSON.stringify(b.amounts)) {
        return json(res, 200, { ok: true, idempotent: true });
      }

      const result = app.applyEntry(st, {
        teamId: b.teamId,
        round,
        amounts: b.amounts,
        role: payload.role,
        coordId: payload.coordId,
      });

      await store.saveAlloc(b.teamId, round, st.allocations[b.teamId][round]);
      await store.audit(payload.coordId, before ? 'entry.correct' : 'entry.set', {
        teamId: b.teamId,
        round,
        before: before?.amounts,
        after: b.amounts,
      });
      return json(res, 200, result);
    }

    // ── Coordinator rumor purchase: POST /api/coord/rumor or /api/rumor/buy ──
    if (m === 'POST' && (p === '/api/coord/rumor' || p === '/api/rumor/buy')) {
      const payload = await need(req, res, 'admin', 'coordinator');
      const b = await readBody(req);
      const st = await store.load();

      if (payload.role === 'coordinator' && payload.coordId !== 'legacy') {
        const coord = await store.getCoordinator(payload.coordId);
        if (coord && !coord.enabled) throw new app.HttpError(403, 'Coordinator account disabled');
        if (!coord || !coord.assignedTeams || !coord.assignedTeams.includes(b.teamId)) {
          throw new app.HttpError(403, 'You are not assigned to this team');
        }
      }

      const round = Number(b.round);
      const result = app.buyRumor(st, {
        teamId: b.teamId,
        round,
        role: payload.role,
        coordId: payload.coordId,
      });

      if (store.saveRumors) {
        await store.saveRumors(b.teamId, round, st.rumors[b.teamId][round]);
      } else {
        await store.save(st);
      }
      await store.audit(payload.coordId, 'rumor.buy', {
        teamId: b.teamId,
        round,
        count: result.rumorCount,
      });
      return json(res, 200, result);
    }

    // ── Admin-only routes ─────────────────────────────────────────────────
    if (p.startsWith('/api/admin/')) {
      const payload = await need(req, res, 'admin');
      const route = p.slice('/api/admin/'.length);
      const st = await store.load();

      // GET routes
      if (m === 'GET') {
        if (route === 'board') {
          return json(res, 200, app.buildBoard(st, { full: true, admin: true }));
        }
        if (route === 'state') {
          const coords = await store.getCoordinators();
          return json(res, 200, {
            ...app.adminState(st, coords),
            adminPinHash: st.settings.adminPinHash,
          });
        }
        if (route === 'export.csv') {
          const coords = await store.getCoordinators();
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="guess-the-growth-results.csv"',
          });
          return res.end(app.exportCsv(st, coords));
        }
        if (route === 'audit') {
          const lines = await store.getAuditLines(200);
          return json(res, 200, { lines });
        }
        if (route === 'coordinators') {
          const coords = await store.getCoordinators();
          return json(res, 200, {
            coordinators: coords.map(({ pinHash, ...rest }) => ({
              ...rest,
              pin: rest.pinPlain || '',
            })),
          });
        }
      }

      // POST routes
      if (m === 'POST') {
        const b = await readBody(req);
        switch (route) {
          case 'advance': {
            app.advance(st, { force: !!b.force });
            const c = app.current(st);
            await commit(st, 'ADMIN', 'advance', { to: c }, {
              backup: (c.phase === 'revealed' || c.phase === 'final') ? `r${c.round}-${c.phase}` : undefined,
            });
            break;
          }
          case 'back':
            app.back(st);
            await commit(st, 'ADMIN', 'back', { to: app.current(st) });
            break;
          case 'final':
            app.finalReveal(st, b.action);
            await commit(st, 'ADMIN', `final.${b.action}`, {});
            break;
          case 'teams': {
            const names = Array.isArray(b.names)
              ? b.names
              : String(b.names || '').split(/\r?\n/);
            const added = app.addTeams(st, names);
            await commit(st, 'ADMIN', 'teams.add', { added: added.map((t) => t.name) });
            break;
          }
          case 'team.remove':
            app.removeTeam(st, b.id);
            await store.deleteAlloc(b.id);
            await commit(st, 'ADMIN', 'team.remove', { id: b.id });
            break;
          case 'news':
            app.setNews(st, b.round, b.items);
            await commit(st, 'ADMIN', 'news.set', { round: b.round });
            break;
          case 'returns': {
            const retRes = app.setReturns(st, b.csv);
            await commit(st, 'ADMIN', 'returns.set', {}, { backup: 'returns' });
            return json(res, 200, { ok: true, count: retRes.count, warnings: retRes.warnings });
          }
          case 'rumors/adjust': {
            const result = app.adjustRumors(st, { teamId: b.teamId, round: b.round, count: b.count });
            if (store.saveRumors) {
              await store.saveRumors(b.teamId, Number(b.round), Number(b.count));
            } else {
              await store.save(st);
            }
            await store.audit('ADMIN', 'rumor.adjust', { teamId: b.teamId, round: b.round, before: result.before, after: result.after });
            return json(res, 200, result);
          }
          case 'settings':
            app.setSettings(st, b);
            await commit(st, 'ADMIN', 'settings', b);
            break;
          case 'backup':
            await store.backup('manual');
            break;
          case 'reset':
            if (b.confirm !== 'RESET') throw new app.HttpError(400, 'Type RESET to confirm');
            await store.backup('before-reset');
            app.resetEvent(st, { clearTeams: !!b.clearTeams });
            await commit(st, 'ADMIN', 'reset', { clearTeams: !!b.clearTeams });
            break;

          // ── Coordinator management ─────────────────────────────────────
          case 'coordinators/generate': {
            const count = Math.max(1, Math.min(100, Number(b.count) || 1));
            const existing = await store.getCoordinators();
            const existing_codes = new Set(existing.map((c) => c.code));
            const created = [];
            for (let i = 1; i <= count + existing.length; i++) {
              const code = `C${String(i).padStart(2, '0')}`;
              if (existing_codes.has(code)) continue;
              if (created.length >= count) break;
              const pin = randPin6();
              const coord = {
                id: `coord-${code.toLowerCase()}`,
                code,
                pinHash: hashPin(pin),
                assignedTeams: [],
                enabled: true,
                createdAt: Date.now(),
                _pinPlain: pin,
              };
              await store.setCoordinator(coord);
              await store.audit('ADMIN', 'coord.create', { code });
              created.push({ code, pin, id: coord.id });
            }
            return json(res, 200, { created });
          }

          case 'coordinators/assign': {
            const allCoords = (await store.getCoordinators()).filter((c) => c.enabled);
            const allTeams = (await store.load()).teams;
            if (!allCoords.length) throw new app.HttpError(400, 'No enabled coordinators');
            for (const c of allCoords) {
              c.assignedTeams = [];
            }
            allTeams.forEach((t, i) => {
              allCoords[i % allCoords.length].assignedTeams.push(t.id);
            });
            for (const c of allCoords) {
              await store.setCoordinator(c);
            }
            await store.audit('ADMIN', 'coord.auto-assign', { teams: allTeams.length, coords: allCoords.length });
            return json(res, 200, { ok: true });
          }

          case 'coordinators/reset-pin': {
            const coord = await store.getCoordinator(b.coordId);
            if (!coord) throw new app.HttpError(404, 'Coordinator not found');
            const pin = randPin6();
            coord.pinHash = hashPin(pin);
            await store.setCoordinator(coord);
            await store.audit('ADMIN', 'coord.reset-pin', { code: coord.code });
            return json(res, 200, { pin });
          }

          case 'coordinators/toggle': {
            const coord = await store.getCoordinator(b.coordId);
            if (!coord) throw new app.HttpError(404, 'Coordinator not found');
            coord.enabled = !coord.enabled;
            await store.setCoordinator(coord);
            await store.audit('ADMIN', coord.enabled ? 'coord.enable' : 'coord.disable', { code: coord.code });
            return json(res, 200, { enabled: coord.enabled });
          }

          case 'coordinators/delete': {
            const coord = await store.getCoordinator(b.coordId);
            if (!coord) throw new app.HttpError(404, 'Coordinator not found');
            await store.deleteCoordinator(b.coordId);
            await store.audit('ADMIN', 'coord.delete', { code: coord.code });
            return json(res, 200, { ok: true });
          }

          case 'coordinators/set-teams': {
            const coord = await store.getCoordinator(b.coordId);
            if (!coord) throw new app.HttpError(404, 'Coordinator not found');
            coord.assignedTeams = Array.isArray(b.teamIds) ? b.teamIds : [];
            await store.setCoordinator(coord);
            await store.audit('ADMIN', 'coord.set-teams', { code: coord.code, teams: coord.assignedTeams });
            return json(res, 200, { ok: true });
          }

          default:
            throw new app.HttpError(404, 'Unknown admin action');
        }
        return json(res, 200, { ok: true });
      }
    }

    throw new app.HttpError(404, 'Not found');
  }

  // ─── Static file serving ──────────────────────────────────────────────────
  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof app.HttpError || e.status) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e);
      return json(res, 500, { error: 'Server error: ' + e.message });
    }
  };
}

export function createApp(store) {
  return http.createServer(createRequestHandler(store));
}

// ─── Run directly: node src/server.js ────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await createStore();
  const st = await store.load();
  const port = Number(process.env.PORT || 3000);
  createApp(store).listen(port, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);

    console.log('\nGuess the Growth is running\n');
    console.log(`  This laptop : http://localhost:${port}`);
    for (const ip of ips) console.log(`  On the LAN  : http://${ip}:${port}`);
    if (store.adminPinPlain) console.log(`\n  Admin PIN       : ${store.adminPinPlain}`);
    if (store.coordinatorPinPlain) console.log(`  Coordinator PIN : ${store.coordinatorPinPlain}`);
    console.log('\n  Pages: /display.html (projector)  /coordinator.html (coordinators)  /admin.html (you)\n');
  });
}
