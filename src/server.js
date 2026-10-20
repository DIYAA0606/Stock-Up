// Zero-dependency HTTP server: static pages + JSON API. Run on one laptop; everyone else joins over the LAN.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.js';
import * as app from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function roleOf(store, req) {
  const pin = String(req.headers['x-pin'] || '');
  if (!pin) return null;
  const { pins } = store.state.settings;
  if (pin === pins.admin) return 'admin';
  if (pin === pins.coordinator) return 'coordinator';
  return null;
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch {
        return Promise.reject(new app.HttpError(400, 'Body is not valid JSON'));
      }
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new app.HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createRequestHandler(store) {
  const st = () => store.state;
  const fails = new Map(); // ip -> [timestamps] ; slows down PIN guessing

  const json = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  function need(req, res, ...roles) {
    const rawIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?');
    const ip = rawIp.split(',')[0].trim();
    const recent = (fails.get(ip) || []).filter((t) => Date.now() - t < 60_000);
    fails.set(ip, recent);
    if (recent.length >= 15) throw new app.HttpError(429, 'Too many wrong PINs. Wait a minute.');
    const role = roleOf(store, req);
    if (!role) {
      recent.push(Date.now());
      throw new app.HttpError(401, 'Wrong or missing PIN');
    }
    if (!roles.includes(role)) throw new app.HttpError(403, 'Not allowed for your role');
    return role;
  }

  // Saves state, writes an audit line, and keeps a backup when results go public.
  const commit = (role, action, detail, { backup } = {}) => {
    store.save();
    store.audit(role, action, detail);
    if (backup) store.backup(backup);
  };

  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname;

    if (m === 'GET' && (p === '/api' || p === '/api/')) return json(res, 200, { ok: true, name: 'guess-the-growth' });

    if (m === 'GET' && p === '/api/board') return json(res, 200, app.buildBoard(st()));

    if (m === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      req.headers['x-pin'] = String(body.pin || '');
      const role = need(req, res, 'admin', 'coordinator');
      return json(res, 200, { role });
    }

    // ----- coordinator + admin -----
    if (m === 'GET' && p === '/api/entry') {
      const role = need(req, res, 'admin', 'coordinator');
      return json(res, 200, app.entryContext(st(), role, url.searchParams.get('round')));
    }
    if (m === 'POST' && p === '/api/entry') {
      const role = need(req, res, 'admin', 'coordinator');
      const b = await readBody(req);
      const before = (st().allocations[b.teamId] || {})[b.round];
      const result = app.applyEntry(st(), { teamId: b.teamId, round: b.round, amounts: b.amounts, role });
      commit(role, before ? 'entry.correct' : 'entry.set', { teamId: b.teamId, round: Number(b.round), before: before?.amounts, after: st().allocations[b.teamId][Number(b.round)].amounts });
      return json(res, 200, result);
    }

    // ----- admin only -----
    if (p.startsWith('/api/admin/')) {
      const role = need(req, res, 'admin');
      const route = p.slice('/api/admin/'.length);

      if (m === 'GET' && route === 'state') return json(res, 200, { ...app.adminState(st()), pins: st().settings.pins });
      if (m === 'GET' && route === 'export.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="guess-the-growth-results.csv"' });
        return res.end(app.exportCsv(st()));
      }
      if (m === 'GET' && route === 'audit') {
        const f = store.auditFile;
        const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').slice(-200) : [];
        return json(res, 200, { lines: lines.map((l) => JSON.parse(l)).reverse() });
      }

      if (m === 'POST') {
        const b = await readBody(req);
        switch (route) {
          case 'advance': {
            app.advance(st(), { force: !!b.force });
            const c = app.current(st());
            commit(role, 'advance', { to: c }, { backup: c.phase === 'revealed' || c.phase === 'final' ? `r${c.round}-${c.phase}` : undefined });
            break;
          }
          case 'back':
            app.back(st());
            commit(role, 'back', { to: app.current(st()) });
            break;
          case 'final':
            app.finalReveal(st(), b.action);
            commit(role, 'final.' + b.action, {});
            break;
          case 'teams': {
            const names = Array.isArray(b.names) ? b.names : String(b.names || '').split(/\r?\n/);
            const added = app.addTeams(st(), names);
            commit(role, 'teams.add', { added: added.map((t) => t.name) });
            break;
          }
          case 'team.remove':
            app.removeTeam(st(), b.id);
            commit(role, 'team.remove', { id: b.id });
            break;
          case 'news':
            app.setNews(st(), b.round, b.items);
            commit(role, 'news.set', { round: b.round });
            break;
          case 'returns':
            app.setReturns(st(), b.csv);
            commit(role, 'returns.set', {}, { backup: 'returns' });
            break;
          case 'settings':
            app.setSettings(st(), b);
            commit(role, 'settings', b);
            break;
          case 'backup':
            store.save();
            store.backup('manual');
            break;
          case 'reset':
            if (b.confirm !== 'RESET') throw new app.HttpError(400, 'Type RESET to confirm');
            store.backup('before-reset');
            app.resetEvent(st(), { clearTeams: !!b.clearTeams });
            commit(role, 'reset', { clearTeams: !!b.clearTeams });
            break;
          default:
            throw new app.HttpError(404, 'Unknown admin action');
        }
        return json(res, 200, { ok: true });
      }
    }
    throw new app.HttpError(404, 'Not found');
  }

  function serveStatic(req, res, url) {
    return new Promise((resolve) => {
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return resolve();
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return resolve();
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
        resolve();
      });
    });
  }

  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      let pathname = url.pathname;
      if (pathname === '/api' || pathname.startsWith('/api/[')) {
        if (req.query?.path) {
          const sub = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
          pathname = '/api/' + sub.replace(/^\/+/, '');
        } else if (url.searchParams.get('path')) {
          pathname = '/api/' + url.searchParams.get('path').replace(/^\/+/, '');
        }
      }
      url.pathname = pathname;

      if (url.pathname.startsWith('/api')) return await api(req, res, url);
      return await serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof app.HttpError) return json(res, e.status, { error: e.message, ...e.extra });
      console.error(e);
      return json(res, 500, { error: 'Server error: ' + e.message });
    }
  };
}

export function createApp(store) {
  return http.createServer(createRequestHandler(store));
}

// ---- run directly: node src/server.js ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
  const store = new Store(dataDir);
  if (process.env.ADMIN_PIN) store.state.settings.pins.admin = process.env.ADMIN_PIN;
  if (process.env.COORDINATOR_PIN) store.state.settings.pins.coordinator = process.env.COORDINATOR_PIN;
  store.save();
  const port = Number(process.env.PORT || 3000);
  createApp(store).listen(port, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const { pins } = store.state.settings;
    console.log('\nGuess the Growth is running\n');
    console.log(`  This laptop : http://localhost:${port}`);
    for (const ip of ips) console.log(`  On the LAN  : http://${ip}:${port}`);
    console.log(`\n  Admin PIN       : ${pins.admin}`);
    console.log(`  Coordinator PIN : ${pins.coordinator}`);
    console.log('\n  Pages: /display.html (projector)  /entry.html (coordinators)  /admin.html (you)\n');
  });
}
