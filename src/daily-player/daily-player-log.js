import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createRunLogger(directory, { output = console.log } = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'run.log');
  const started = Date.now();
  const log = (message) => {
    const line = `[${new Date().toISOString()} +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`;
    appendFileSync(path, line + '\n');
    output(line);
  };
  log.path = path;
  log.reviewPath = join(directory, 'review.jsonl');
  log.record = (type, data = {}) => {
    appendFileSync(log.reviewPath, JSON.stringify({ timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - started, type, ...data }) + '\n');
  };
  return log;
}

export async function withProgress(log, stage, operation, { heartbeatMs = 10000 } = {}) {
  if (!log) return operation();
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  log(`${stage}: started`);
  const timer = setInterval(() => log(`${stage}: still waiting (${elapsed()})`), heartbeatMs);
  timer.unref();
  try {
    const result = await operation();
    log(`${stage}: completed (${elapsed()})`);
    return result;
  } catch (error) {
    log(`${stage}: failed (${elapsed()}, ${error.name || 'Error'})`);
    throw error;
  } finally { clearInterval(timer); }
}
