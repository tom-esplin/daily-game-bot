import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunLogger, withProgress } from '../../src/daily-player/daily-player-log.js';

test('progress logs identify pending work and stop heartbeats after completion', async () => {
  const messages = [];
  const result = await withProgress((message) => messages.push(message), 'Local inference', async () => {
    await delay(35);
    return 42;
  }, { heartbeatMs: 5 });
  assert.equal(result, 42);
  assert.match(messages[0], /Local inference: started/);
  assert.ok(messages.some((message) => /still waiting/.test(message)));
  assert.match(messages.at(-1), /completed/);
  const count = messages.length;
  await delay(20);
  assert.equal(messages.length, count);
});

test('progress records failure without leaking error content and clears the heartbeat', async () => {
  const messages = [];
  await assert.rejects(withProgress((message) => messages.push(message), 'API request', async () => {
    throw new Error('sensitive response content');
  }, { heartbeatMs: 5 }), /sensitive response/);
  assert.match(messages.at(-1), /API request: failed/);
  assert.ok(messages.every((message) => !/sensitive/.test(message)));
  const count = messages.length;
  await delay(20);
  assert.equal(messages.length, count);
});

test('run logs are timestamped and persisted before an operation can fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-log-'));
  const output = [];
  try {
    const log = createRunLogger(directory, { output: (line) => output.push(line) });
    log('Preflight started');
    log('Preflight failed');
    const saved = readFileSync(log.path, 'utf8');
    assert.equal(saved, output.join('\n') + '\n');
    assert.match(saved, /^\[\d{4}-\d\d-\d\dT.+ \+\d+\.\ds\] Preflight started/m);
  } finally { rmSync(join(directory, 'run.log')); rmdirSync(directory); }
});

test('structured review events persist in order with timestamps and step correlation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-review-'));
  try {
    const log = createRunLogger(directory, { output() {} });
    log.record('observation', { step: 1, screenshot: 'step-001.png', visibleText: 'Choose a location' });
    log.record('decision', { step: 1, model: 'gpt-6.1-sol', decisionSummary: 'The clue points to Paris.', confidence: 'medium' });
    log.record('action_result', { step: 1, status: 'executed' });
    const events = readFileSync(log.reviewPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.type), ['observation', 'decision', 'action_result']);
    assert.ok(events.every((event) => event.step === 1 && Number.isFinite(Date.parse(event.timestamp))));
    assert.equal(events[1].decisionSummary, 'The clue points to Paris.');
  } finally { rmSync(join(directory, 'review.jsonl')); rmdirSync(directory); }
});
