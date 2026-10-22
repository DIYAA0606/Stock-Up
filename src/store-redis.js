// RedisStore — Upstash Redis implementation of the store interface.
import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';
import { parseReturnsCsv } from './engine.js';
import { loadReturnsCsv } from './seed.js';
import { hashPin } from './auth.js';

const randPin = () => String(crypto.randomInt(1000, 10000));

function freshConfig() {
  const csv = loadReturnsCsv();
  const companies = parseReturnsCsv(csv, 4).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  const ap = process.env.ADMIN_PIN;
  const cp = process.env.COORDINATOR_PIN;

  const settings = {
    startingCapital: '100',
    rounds: 4,
    durations: { info: 20, news: 5, investing: 10, entry: 5 },
    penaltyMode: 'every_quarter',
    penaltyPercent: 15,
    minPerStock: '1',
    rumorFee: '5',
    adminPinHash: ap ? hashPin(ap) : hashPin('1234'),
    coordinatorPinHash: cp ? hashPin(cp) : hashPin('1234'),
  };

  return {
    version: 2,
    settings,
    companies,
    nextCompanyId: companies.length,
    nextTeamId: 0,
    news: {},
    step: 0,
    phaseStartedAt: Date.now(),
    phaseEndsAt: null,
    finalReveal: 0,
    returnsIsSample: true,
    returnsWarnings: [],
  };
}

export class RedisStore {
  constructor(opts = {}) {
    if (opts.redis) {
      this.redis = opts.redis;
    } else {
      const url = opts.url || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
      const token = opts.token || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
      if (!url || !token) {
        throw new Error('RedisStore requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
      }
      this.redis = new Redis({ url, token });
    }
  }

  async load() {
    let rawConfig = await this.redis.get('config');
    let config;

    if (!rawConfig) {
      config = freshConfig();
      await this.redis.set('config', JSON.stringify(config));
    } else {
      config = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    }

    const rawTeams = (await this.redis.hgetall('teams')) || {};
    const teams = Object.values(rawTeams).map((t) => (typeof t === 'string' ? JSON.parse(t) : t));

    const allocations = {};
    const rumors = {};
    if (teams.length > 0) {
      const p = this.redis.pipeline();
      for (const t of teams) {
        p.hgetall(`alloc:${t.id}`);
        p.hgetall(`rumors:${t.id}`);
      }
      const results = await p.exec();
      teams.forEach((t, i) => {
        const rawAlloc = results[i * 2] || {};
        allocations[t.id] = {};
        for (const [round, val] of Object.entries(rawAlloc)) {
          allocations[t.id][round] = typeof val === 'string' ? JSON.parse(val) : val;
        }
        const rawRumors = results[i * 2 + 1] || {};
        rumors[t.id] = {};
        for (const [round, val] of Object.entries(rawRumors)) {
          rumors[t.id][round] = typeof val === 'string' ? JSON.parse(val) : Number(val);
        }
      });
    }

    return {
      version: 2,
      settings: config.settings,
      companies: config.companies,
      nextCompanyId: config.nextCompanyId ?? config.companies.length,
      teams,
      nextTeamId: config.nextTeamId ?? teams.length,
      news: config.news || {},
      allocations,
      rumors,
      step: config.step ?? 0,
      phaseStartedAt: config.phaseStartedAt ?? Date.now(),
      phaseEndsAt: config.phaseEndsAt ?? null,
      finalReveal: config.finalReveal ?? 0,
      returnsIsSample: config.returnsIsSample ?? true,
      returnsWarnings: config.returnsWarnings || [],
    };
  }

  async save(st) {
    const config = {
      version: 2,
      settings: st.settings,
      companies: st.companies,
      nextCompanyId: st.nextCompanyId,
      nextTeamId: st.nextTeamId,
      news: st.news,
      step: st.step,
      phaseStartedAt: st.phaseStartedAt,
      phaseEndsAt: st.phaseEndsAt,
      finalReveal: st.finalReveal,
      returnsIsSample: st.returnsIsSample,
      returnsWarnings: st.returnsWarnings,
    };

    const p = this.redis.pipeline();
    p.set('config', JSON.stringify(config));

    p.del('teams');
    if (st.teams && st.teams.length > 0) {
      for (const t of st.teams) {
        p.hset('teams', { [t.id]: JSON.stringify(t) });
      }
    }
    p.del('board:cache');
    await p.exec();
  }

  async saveAlloc(teamId, round, entry) {
    const p = this.redis.pipeline();
    p.hset(`alloc:${teamId}`, { [String(round)]: JSON.stringify(entry) });
    p.del('board:cache');
    await p.exec();
  }

  async saveRumors(teamId, round, count) {
    const p = this.redis.pipeline();
    p.hset(`rumors:${teamId}`, { [String(round)]: String(count) });
    p.del('board:cache');
    await p.exec();
  }

  async deleteAlloc(teamId) {
    const p = this.redis.pipeline();
    p.del(`alloc:${teamId}`);
    p.del(`rumors:${teamId}`);
    p.del('board:cache');
    await p.exec();
  }

  async getCoordinators() {
    const raw = (await this.redis.hgetall('coords')) || {};
    return Object.values(raw).map((c) => (typeof c === 'string' ? JSON.parse(c) : c));
  }

  async getCoordinator(coordId) {
    const raw = await this.redis.hget('coords', coordId);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async setCoordinator(coord) {
    await this.redis.hset('coords', { [coord.id]: JSON.stringify(coord) });
  }

  async deleteCoordinator(coordId) {
    await this.redis.hdel('coords', coordId);
  }

  async audit(who, action, detail = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), who, action, ...detail });
    const p = this.redis.pipeline();
    p.lpush('audit', line);
    p.ltrim('audit', 0, 999);
    await p.exec();
  }

  async getAuditLines(n = 200) {
    const raw = await this.redis.lrange('audit', 0, n - 1);
    if (!raw || !Array.isArray(raw)) return [];
    return raw
      .map((l) => {
        try {
          return typeof l === 'string' ? JSON.parse(l) : l;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async backup(label) {
    const st = await this.load();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.redis.set(`backup:${stamp}:${label}`, JSON.stringify(st));
  }

  async getBoardCache() {
    const val = await this.redis.get('board:cache');
    if (!val) return null;
    return typeof val === 'string' ? val : JSON.stringify(val);
  }

  async setBoardCache(json, ttlSec = 2) {
    await this.redis.set('board:cache', json, { ex: ttlSec });
  }

  async invalidateBoardCache() {
    await this.redis.del('board:cache');
  }

  async recordFailAndCheck(key, maxHits = 15, windowSec = 60) {
    const redisKey = `rate:${key}`;
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const min = now - windowMs;

    const p = this.redis.pipeline();
    p.zremrangebyscore(redisKey, 0, min);
    p.zcard(redisKey);
    p.zadd(redisKey, { score: now, member: `${now}:${Math.random().toString(36).slice(2, 7)}` });
    p.expire(redisKey, windowSec * 2);

    const results = await p.exec();
    const currentCount = results[1] || 0;
    return currentCount >= maxHits;
  }

  async isRateLimited(key, maxHits = 15, windowSec = 60) {
    const redisKey = `rate:${key}`;
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const min = now - windowMs;

    const p = this.redis.pipeline();
    p.zremrangebyscore(redisKey, 0, min);
    p.zcard(redisKey);
    const results = await p.exec();
    const count = results[1] || 0;
    return count >= maxHits;
  }
}
