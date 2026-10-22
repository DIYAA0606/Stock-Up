// FileStore — local-dev / npm-start / npm-test implementation of the store interface.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseReturnsCsv } from './engine.js';
import { loadReturnsCsv } from './seed.js';
import { hashPin } from './auth.js';

const randPin = () => String(crypto.randomInt(1000, 10000));

function freshState() {
  const csv = loadReturnsCsv();
  const companies = parseReturnsCsv(csv, 4).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  return {
    version: 2,
    settings: {
      startingCapital: '100',
      rounds: 4,
      durations: { info: 20, news: 5, investing: 10, entry: 5 },
      penaltyMode: 'every_quarter',
      penaltyPercent: 15,
      minPerStock: '1',
      rumorFee: '5',
      adminPinHash: null,
      coordinatorPinHash: null,
    },
    companies,
    nextCompanyId: companies.length,
    teams: [],
    nextTeamId: 0,
    news: {},
    allocations: {},
    rumors: {},
    step: 0,
    phaseStartedAt: Date.now(),
    phaseEndsAt: null,
    finalReveal: 0,
    returnsIsSample: true,
    returnsWarnings: [],
  };
}

export class FileStore {
  /**
   * @param {string} dir  Directory holding state.json, coordinators.json, audit.log, backups/
   */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.coordFile = path.join(dir, 'coordinators.json');
    this.auditFile = path.join(dir, 'audit.log');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });

    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.state.settings.pins) this._migratePins();
      if (!this.state.rumors) this.state.rumors = {};
      if (this.state.returnsIsSample === undefined) this.state.returnsIsSample = true;
      if (!this.state.returnsWarnings) this.state.returnsWarnings = [];
    } else {
      this.state = freshState();
      this._applyEnvPins();
      this._writeState();
    }

    this._coords = fs.existsSync(this.coordFile)
      ? JSON.parse(fs.readFileSync(this.coordFile, 'utf8'))
      : {};

    this._rateLimits = new Map();
    this._boardCache = null;
  }

  async load() {
    return this.state;
  }

  async save(st = this.state) {
    this.state = st;
    this._writeState();
    await this.invalidateBoardCache();
  }

  async saveAlloc(teamId, round, entry) {
    if (!this.state.allocations[teamId]) this.state.allocations[teamId] = {};
    this.state.allocations[teamId][round] = entry;
    this._writeState();
    await this.invalidateBoardCache();
  }

  async saveRumors(teamId, round, count) {
    if (!this.state.rumors) this.state.rumors = {};
    if (!this.state.rumors[teamId]) this.state.rumors[teamId] = {};
    this.state.rumors[teamId][round] = count;
    this._writeState();
    await this.invalidateBoardCache();
  }

  async deleteAlloc(teamId) {
    delete this.state.allocations[teamId];
    if (this.state.rumors) delete this.state.rumors[teamId];
    this._writeState();
    await this.invalidateBoardCache();
  }

  async getCoordinators() {
    return Object.values(this._coords);
  }

  async getCoordinator(coordId) {
    return this._coords[coordId] ?? null;
  }

  async setCoordinator(coord) {
    this._coords[coord.id] = coord;
    this._writeCoords();
  }

  async deleteCoordinator(coordId) {
    delete this._coords[coordId];
    this._writeCoords();
  }

  async audit(who, action, detail = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), who, action, ...detail });
    fs.appendFileSync(this.auditFile, line + '\n', 'utf8');
  }

  async getAuditLines(n = 200) {
    if (!fs.existsSync(this.auditFile)) return [];
    const lines = fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async backup(label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(this.file, path.join(this.backupDir, `state-${stamp}-${label}.json`));
  }

  async getBoardCache() {
    if (!this._boardCache) return null;
    if (Date.now() > this._boardCache.expiresAt) { this._boardCache = null; return null; }
    return this._boardCache.json;
  }

  async setBoardCache(json, ttlSec = 2) {
    this._boardCache = { json, expiresAt: Date.now() + ttlSec * 1000 };
  }

  async invalidateBoardCache() {
    this._boardCache = null;
  }

  async recordFailAndCheck(key, maxHits = 15, windowSec = 60) {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const ts = (this._rateLimits.get(key) || []).filter((t) => now - t < windowMs);
    if (ts.length >= maxHits) {
      this._rateLimits.set(key, ts);
      return true;
    }
    ts.push(now);
    this._rateLimits.set(key, ts);
    return false;
  }

  async isRateLimited(key, maxHits = 15, windowSec = 60) {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const ts = (this._rateLimits.get(key) || []).filter((t) => now - t < windowMs);
    this._rateLimits.set(key, ts);
    return ts.length >= maxHits;
  }

  get adminPinPlain() { return this.state.settings._adminPinPlain ?? null; }
  get coordinatorPinPlain() { return this.state.settings._coordinatorPinPlain ?? null; }
  get adminPinHash() { return this.state.settings.adminPinHash; }
  get coordinatorPinHash() { return this.state.settings.coordinatorPinHash; }

  _applyEnvPins() {
    const ap = process.env.ADMIN_PIN;
    const cp = process.env.COORDINATOR_PIN;
    if (ap) {
      this.state.settings.adminPinHash = hashPin(ap);
      this.state.settings._adminPinPlain = null;
    } else {
      const plain = randPin();
      this.state.settings.adminPinHash = hashPin(plain);
      this.state.settings._adminPinPlain = plain;
    }
    if (cp) {
      this.state.settings.coordinatorPinHash = hashPin(cp);
      this.state.settings._coordinatorPinPlain = null;
    } else {
      const plain = randPin();
      this.state.settings.coordinatorPinHash = hashPin(plain);
      this.state.settings._coordinatorPinPlain = plain;
    }
  }

  _migratePins() {
    const old = this.state.settings.pins || {};
    const ap = process.env.ADMIN_PIN || old.admin;
    const cp = process.env.COORDINATOR_PIN || old.coordinator;
    this.state.settings.adminPinHash = hashPin(ap);
    this.state.settings._adminPinPlain = process.env.ADMIN_PIN ? null : ap;
    this.state.settings.coordinatorPinHash = hashPin(cp);
    this.state.settings._coordinatorPinPlain = process.env.COORDINATOR_PIN ? null : cp;
    this.state.version = 2;
    delete this.state.settings.pins;
    this._writeState();
  }

  _writeState() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _writeCoords() {
    const tmp = this.coordFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._coords, null, 2));
    fs.renameSync(tmp, this.coordFile);
  }
}
