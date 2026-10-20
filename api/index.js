import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../src/store.js';
import { createRequestHandler } from '../src/server.js';

const dataDir = process.env.DATA_DIR || path.join(os.tmpdir(), 'guess-the-growth-data');

let storeInstance = null;
let requestHandler = null;

function getStore() {
  if (!storeInstance) {
    fs.mkdirSync(dataDir, { recursive: true });

    const stateFile = path.join(dataDir, 'state.json');
    if (!fs.existsSync(stateFile)) {
      const seedFile = path.join(process.cwd(), 'data', 'state.json');
      if (fs.existsSync(seedFile)) {
        try {
          fs.copyFileSync(seedFile, stateFile);
        } catch (e) {
          console.warn('Seed copy warning:', e.message);
        }
      }
    }

    storeInstance = new Store(dataDir);
    if (process.env.ADMIN_PIN) {
      storeInstance.state.settings.pins.admin = String(process.env.ADMIN_PIN);
    }
    if (process.env.COORDINATOR_PIN) {
      storeInstance.state.settings.pins.coordinator = String(process.env.COORDINATOR_PIN);
    }
  }
  return storeInstance;
}

function getHandler() {
  if (!requestHandler) {
    const store = getStore();
    requestHandler = createRequestHandler(store);
  }
  return requestHandler;
}

export default async function handler(req, res) {
  try {
    const fn = getHandler();
    return await fn(req, res);
  } catch (err) {
    console.error('Serverless Handler Error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: err.message, stack: err.stack }));
  }
}
