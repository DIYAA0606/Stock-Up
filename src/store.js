// JSON-file persistence with atomic writes, an audit log and timestamped backups. No database to install.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseReturnsCsv } from './engine.js';
import { SEED_CSV } from './seed.js';

const pin = () => String(crypto.randomInt(1000, 10000));

function freshState() {
  const companies = parseReturnsCsv(SEED_CSV, 6).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  return {
    version: 1,
    settings: {
      startingCapital: '100',
      rounds: 6,
      durations: { info: 20, news: 5, investing: 10, entry: 5 }, // minutes, from the deck
      pins: { admin: pin(), coordinator: pin() },
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

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.auditFile = path.join(dir, 'audit.log');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.state = freshState();
      this.save();
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  backup(label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(this.file, path.join(this.backupDir, `state-${stamp}-${label}.json`));
  }

  audit(who, action, detail = {}) {
    fs.appendFileSync(this.auditFile, JSON.stringify({ at: new Date().toISOString(), who, action, ...detail }) + '\n');
  }
}
