// FileStore — local-dev / npm-start / npm-test implementation of the store interface.
//
// All public methods are async so they share the exact same interface as RedisStore.
// Internally everything is synchronous file I/O wrapped in resolved Promises.
//
// Layout on disk:
//   <dir>/state.json        ← game state (settings, teams, allocations, etc.)
//   <dir>/coordinators.json ← coordinator accounts (code, pinHash, assignedTeams, …)
//   <dir>/audit.log         ← newline-delimited JSON event log
//   <dir>/backups/          ← timestamped pre-action snapshots
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseReturnsCsv } from './engine.js';
import { SEED_CSV } from './seed.js';
import { hashPin } from './auth.js';

const randPin = () => String(crypto.randomInt(1000, 10000));

function freshState() {
  const companies = parseReturnsCsv(SEED_CSV, 6).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  return {
    version: 2,
    settings: {
      startingCapital: '100',
      rounds: 6,
      durations: { info: 20, news: 5, investing: 10, entry: 5 },
      adminPinHash: null,       // set by _applyEnvPins()
      coordinatorPinHash: null, // legacy single-PIN for LAN mode (no coordinators table)
      // _adminPinPlain and _coordinatorPinPlain exist only in dev mode (not committed)
    },
    companies,
    nextCompanyId: companies.length,
    teams: [],
    nextTeamId: 0,
    news: {},
    allocations: {},
    step: 0,
    phaseStartedAt: Date.now(),
    phaseEndsAt: null,
    finalReveal: 0,
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

    // ── Load state ──────────────────────────────────────────────────────────
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Migrate v1 state: settings.pins.{admin,coordinator} → hashed fields.
      if (this.state.settings.pins) this._migratePins();
    } else {
      this.state = freshState();
      this._applyEnvPins();
      this._writeState();
    }

    // ── Load coordinators sidecar ────────────────────────────────────────────
    this._coords = fs.existsSync(this.coordFile)
      ? JSON.parse(fs.readFileSync(this.coordFile, 'utf8'))
      : {};

    // ── In-memory rate limiting: key → [timestamps] ──────────────────────────
    this._rateLimits = new Map();

    // ── In-process board cache ────────────────────────────────────────────────
    this._boardCache = null; // { json, expiresAt }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Core state
  // ═══════════════════════════════════════════════════════════════════════════

  /** Return the full state object. Also updates this.state for direct access. */
  async load() {
    return this.state;
  }

  /**
   * Persist the full state object.
   * NOTE: does NOT save allocations — call saveAlloc() for per-team chit writes.
   */
  async save(st) {
    this.state = st;
    this._writeState();
    await this.invalidateBoardCache();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Allocations — granular writes (one team at a time)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Atomically save one team-round allocation.
   * Single-process FileStore: synchronous write = inherently race-free.
   *
   * @param {string} teamId
   * @param {number} round
   * @param {{ amounts: object, by: string, at: number }} entry
   */
  async saveAlloc(teamId, round, entry) {
    if (!this.state.allocations[teamId]) this.state.allocations[teamId] = {};
    this.state.allocations[teamId][round] = entry;
    this._writeState();
    await this.invalidateBoardCache();
  }

  /** Remove all allocations for a team (called when a team is deleted). */
  async deleteAlloc(teamId) {
    delete this.state.allocations[teamId];
    this._writeState();
    await this.invalidateBoardCache();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Coordinators
  // ═══════════════════════════════════════════════════════════════════════════

  /** Returns all coordinator objects as an array. */
  async getCoordinators() {
    return Object.values(this._coords);
  }

  /** Returns a single coordinator by id, or null. */
  async getCoordinator(coordId) {
    return this._coords[coordId] ?? null;
  }

  /** Upsert a coordinator. The object must have an `id` field. */
  async setCoordinator(coord) {
    this._coords[coord.id] = coord;
    this._writeCoords();
  }

  /** Remove a coordinator by id. */
  async deleteCoordinator(coordId) {
    delete this._coords[coordId];
    this._writeCoords();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Audit
  // ═══════════════════════════════════════════════════════════════════════════

  /** Append a structured audit event to audit.log. */
  async audit(who, action, detail = {}) {
    fs.appendFileSync(
      this.auditFile,
      JSON.stringify({ at: new Date().toISOString(), who, action, ...detail }) + '\n',
    );
  }

  /**
   * Return the last `n` audit lines, most-recent first.
   * @param {number} n
   */
  async getAuditLines(n = 200) {
    if (!fs.existsSync(this.auditFile)) return [];
    const raw = fs.readFileSync(this.auditFile, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-n)
      .reverse();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Backups
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Write a timestamped snapshot of state.json to the backups/ directory.
   * @param {string} label  Human label, e.g. 'r2-revealed', 'before-reset'
   */
  async backup(label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(this.file, path.join(this.backupDir, `state-${stamp}-${label}.json`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Board cache  (cheap 2-second TTL to absorb projector/phone polling bursts)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Returns cached board JSON string, or null if missing / expired. */
  async getBoardCache() {
    if (!this._boardCache) return null;
    if (Date.now() > this._boardCache.expiresAt) { this._boardCache = null; return null; }
    return this._boardCache.json;
  }

  /**
   * Store a board JSON string with a TTL.
   * @param {string} json
   * @param {number} ttlSec
   */
  async setBoardCache(json, ttlSec = 2) {
    this._boardCache = { json, expiresAt: Date.now() + ttlSec * 1000 };
  }

  /** Invalidate the board cache (auto-called after every mutating write). */
  async invalidateBoardCache() {
    this._boardCache = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rate limiting  (in-memory sliding window)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a failed attempt and return true if the key is now over the limit.
   * @param {string} key       e.g. 'ip:192.168.1.1' or 'code:C01'
   * @param {number} maxHits   block after this many recent failures (default 15)
   * @param {number} windowSec sliding window in seconds (default 60)
   * @returns {Promise<boolean>}  true = blocked
   */
  async recordFailAndCheck(key, maxHits = 15, windowSec = 60) {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const ts = (this._rateLimits.get(key) || []).filter((t) => now - t < windowMs);
    if (ts.length >= maxHits) {
      this._rateLimits.set(key, ts); // keep pruned, don't add new hit
      return true;
    }
    ts.push(now);
    this._rateLimits.set(key, ts);
    return false;
  }

  /**
   * Check (without recording) if a key is currently over the limit.
   * @returns {Promise<boolean>}
   */
  async isRateLimited(key, maxHits = 15, windowSec = 60) {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const ts = (this._rateLimits.get(key) || []).filter((t) => now - t < windowMs);
    this._rateLimits.set(key, ts);
    return ts.length >= maxHits;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PIN helpers  (expose for server startup logging)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Plain-text admin PIN — only available in dev mode, null in production. */
  get adminPinPlain() { return this.state.settings._adminPinPlain ?? null; }

  /** Plain-text coordinator PIN — only available in dev mode, null in production. */
  get coordinatorPinPlain() { return this.state.settings._coordinatorPinPlain ?? null; }

  /** Hashed admin PIN (always available). */
  get adminPinHash() { return this.state.settings.adminPinHash; }

  /** Hashed legacy coordinator PIN (LAN mode fallback). */
  get coordinatorPinHash() { return this.state.settings.coordinatorPinHash; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /** Set admin + coordinator PIN hashes from env or random fallback. */
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

  /** Migrate v1 state: plain-text settings.pins → hashed fields. */
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

  /** Atomic write: tmp file then rename. */
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
