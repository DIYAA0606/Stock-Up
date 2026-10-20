import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createRequestHandler } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(os.tmpdir(), 'guess-the-growth-data');

function getStore() {
  const stateFile = path.join(dataDir, 'state.json');
  if (!fs.existsSync(stateFile)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const seedFile = path.join(here, '..', 'data', 'state.json');
      if (fs.existsSync(seedFile)) {
        fs.copyFileSync(seedFile, stateFile);
      }
    } catch (e) {
      console.warn('Initial state setup warning:', e.message);
    }
  }

  const store = new Store(dataDir);
  if (process.env.ADMIN_PIN) {
    store.state.settings.pins.admin = process.env.ADMIN_PIN;
  }
  if (process.env.COORDINATOR_PIN) {
    store.state.settings.pins.coordinator = process.env.COORDINATOR_PIN;
  }
  return store;
}

const store = getStore();
const handler = createRequestHandler(store);

export default async function (req, res) {
  return handler(req, res);
}
