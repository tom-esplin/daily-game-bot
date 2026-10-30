import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAudioListener } from '../../src/daily-player/local-audio.js';
import { DailyPlayerModel } from '../../src/daily-player/daily-player-model.js';
import { DAILY_PLAYER } from '../../src/daily-player/daily-player-config.js';

const settings = { ...DAILY_PLAYER, audioBackend: 'local' };

test('local listener accepts only loopback endpoints', () => {
  for (const localAudioUrl of ['https://example.com', 'http://192.168.1.1:8765', 'http://user:secret@localhost:8765', 'http://localhost:8765/api']) {
    assert.throws(() => new LocalAudioListener({ ...settings, localAudioUrl }), /loopback/);
  }
  assert.doesNotThrow(() => new LocalAudioListener(settings));
});

test('local preflight checks Sol and the trained listener, without requiring any OpenAI audio model', async () => {
  const requests = [];
  const model = new DailyPlayerModel(settings, { apiKey: 'test-secret', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ status: 'ready', model: settings.localAudioModel }) };
  } });
  await model.preflight();
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /models\/gpt-6.1-sol$/);
  assert.equal(requests[1].url, 'http://127.0.0.1:8765/health');
  assert.equal(requests[1].options.headers?.Authorization, undefined);
});

test('local listening sends audio bytes without API credentials or metadata and records local usage', async () => {
  const usage = [];
  const events = [];
  const log = () => {};
  log.record = (type, data) => events.push({ type, ...data });
  const model = new DailyPlayerModel(settings, { apiKey: 'test-secret', onUsage: (record) => usage.push(record),
    log,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8765/listen');
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { audio: Buffer.from('pcm-wav').toString('base64') });
      return { ok: true, json: async () => ({ model: settings.localAudioModel, text: 'Likely 1970s funk; uncertain.', usage: { output_tokens: 12 } }) };
    } });
  assert.match(await model.listen(Buffer.from('pcm-wav'), undefined, { step: 3 }), /1970s/);
  assert.equal(usage[0].model, settings.localAudioModel);
  assert.equal(usage[0].usage.local, true);
  assert.equal(events[0].type, 'audio_assessment');
  assert.equal(events[0].step, 3);
  assert.equal(events[0].assessment, 'Likely 1970s funk; uncertain.');
  assert.ok(!JSON.stringify(events).includes('test-secret'));
});

test('missing, unready and mismatched local models produce actionable errors', async () => {
  const offline = new LocalAudioListener(settings, { fetchImpl: async () => { throw new Error('refused'); } });
  await assert.rejects(offline.preflight(), /npm run daily:audio/);
  const mismatch = new LocalAudioListener(settings, { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ready', model: 'other' }) }) });
  await assert.rejects(mismatch.preflight(), /configured model/);
  await assert.rejects(mismatch.listen(Buffer.from('audio')), /invalid assessment/);
});
