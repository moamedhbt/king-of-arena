/** سجل الجولات — JSON Lines. أساس ضبط التوازن لاحقًا. */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const FILE = resolve(DATA_DIR, 'rounds.jsonl');
let ready: Promise<unknown> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ensure() {
  if (!ready) ready = mkdir(dirname(FILE), { recursive: true });
  return ready;
}

export function appendRoundLog(entry: Record<string, unknown>) {
  if (process.env.TELEMETRY === 'off') return;
  const line = JSON.stringify(entry) + '\n';
  queue = queue
    .then(() => ensure())
    .then(() => appendFile(FILE, line, 'utf8'))
    .catch((e) => {
      console.error('[telemetry] فشل الكتابة:', (e as Error).message);
    });
}

export function telemetryPath() {
  return FILE;
}
