import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RETURNS_CSV_PATH = path.join(__dirname, '..', 'config', 'returns.csv');

export function loadReturnsCsv() {
  if (fs.existsSync(RETURNS_CSV_PATH)) {
    return fs.readFileSync(RETURNS_CSV_PATH, 'utf8');
  }
  throw new Error(`Returns matrix file not found: ${RETURNS_CSV_PATH}`);
}

export function saveReturnsCsv(csv) {
  fs.writeFileSync(RETURNS_CSV_PATH, csv, 'utf8');
}
