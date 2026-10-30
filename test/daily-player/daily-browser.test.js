import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { DAILY_PLAYER } from '../../src/daily-player/daily-player-config.js';
import { capturePlayableAudio, encodeWav, performGameAction, playDailyGame } from '../../src/daily-player/daily-browser.js';
import { parseDailyResult, visibleCodenamesShare } from '../../src/daily-player/daily-results.js';

test('audio encoder produces a bounded mono PCM WAV and rejects silence or malformed samples', () => {
  const wav = encodeWav([0.5, -0.5, 1], 48000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.length, 50);
  assert.throws(() => encodeWav([0, 0], 48000), /silent/);
  assert.throws(() => encodeWav([NaN], 48000), /Invalid/);
  assert.throws(() => encodeWav([1], 0), /Invalid/);
  assert.throws(() => encodeWav(Array(8000 * 13).fill(0.5), 8000), /Invalid/);
});

test('browser actions reject arbitrary keys, navigation commands, multiline text and offscreen coordinates', async () => {
  const page = {};
  const options = {};
  for (const action of [
    { action: 'click', x: -1, y: 0 }, { action: 'drag', x: 0, y: 0, toX: 1024, toY: 0 },
    { action: 'key', text: 'Control+L' }, { action: 'type', text: 'fake\nscore' },
    { action: 'evaluate', text: 'window.secret' }, { action: 'scroll', x: 0, y: 999999 },
  ]) await assert.rejects(performGameAction(page, action, options));
});

test('listen sends only rendered PCM to the model, charges a call, and rejects capture failures', async () => {
  let charges = 0;
  const page = { waitForFunction: async () => {}, evaluate: async () => ({ samples: [0.1, -0.2], sampleRate: 48000 }) };
  const feedback = await performGameAction(page, { action: 'listen' }, {
    gameKey: 'musictimeliner', chargeCall: () => charges++, model: { listen: async (wav) => {
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      return 'Possibly disco, late 1970s. Uncertain.';
    } },
  });
  assert.equal(charges, 1); assert.match(feedback, /late 1970s/);
  page.evaluate = async () => ({ error: 'CORS blocked' });
  await assert.rejects(performGameAction(page, { action: 'listen' }, { gameKey: 'musictimeliner' }), /CORS/);
  await assert.rejects(performGameAction(page, { action: 'listen' }, { gameKey: 'krillion' }), /only available/);
});

function fakeBrowser({ shareOnClick = 'Krillion #106\n340' } = {}) {
  let share = '';
  let profile;
  let closed = 0;
  const page = { mouse: { click: async () => { share = shareOnClick; } },
    on() {},
    setDefaultTimeout() {}, goto: async () => {}, waitForTimeout: async () => {},
    screenshot: async () => Buffer.from('screen'), title: async () => 'Krillion',
    locator: () => ({ innerText: async () => 'Visible prompt' }),
    evaluate: async () => share,
  };
  const context = { pages: () => [page], addInitScript: async () => {}, route: async () => {}, on() {},
    close: async () => { closed++; } };
  const browserType = { launchPersistentContext: async (directory, options) => {
    profile = directory;
    assert.equal(options.timezoneId, 'America/Denver');
    return context;
  } };
  return { browserType, page, get profile() { return profile; }, get closed() { return closed; } };
}

test('game completion uses captured share text, including on the last allowed action; dry profiles are removed', async () => {
  const browser = fakeBrowser();
  const logs = [];
  const events = [];
  const log = (message) => logs.push(message);
  log.record = (type, data) => events.push({ type, ...data });
  let calls = 0;
  const model = { decide: async () => { calls++; return { action: 'click', x: 10, y: 10,
    decisionSummary: 'The game is complete; copy its native share result.', confidence: 'high' }; } };
  const result = await playDailyGame('krillion', { ...DAILY_PLAYER, maxCalls: 1 }, model,
    { dryRun: true, browserType: browser.browserType, log });
  assert.equal(result.score, 340); assert.equal(result.puzzle, '106');
  assert.equal(calls, 1); assert.equal(browser.closed, 1);
  assert.ok(logs.some((line) => line.includes('Launch Chromium') && line.includes('started')));
  assert.ok(logs.some((line) => line.includes('Gameplay decision 1/1') && line.includes('completed')));
  assert.ok(logs.some((line) => line.includes('Execute click') && line.includes('completed')));
  assert.ok(logs.some((line) => line.includes('Valid native result captured')));
  assert.equal(events.find((event) => event.type === 'decision').confidence, 'high');
  assert.equal(events.find((event) => event.type === 'decision').action.x, 10);
  assert.equal(events.find((event) => event.type === 'observation').visibleText, 'Visible prompt');
  assert.equal(events.find((event) => event.type === 'action_result').status, 'executed');
  assert.equal(events.find((event) => event.type === 'game_result').score, 340);
  await assert.rejects(access(browser.profile));
});

test('cross-origin fallback decodes only the played audio response and sends PCM without metadata', async () => {
  const source = 'https://audio.example/hidden-track-name.mp3';
  let evaluations = 0;
  const page = { waitForFunction: async () => {}, evaluate: async (_callback, args) => {
    evaluations++;
    if (!args) return { error: 'Cross-origin capture blocked', source, startTime: 0 };
    assert.equal(args.source, source);
    assert.equal(Buffer.from(args.base64, 'base64').toString(), 'encoded-preview');
    return { samples: [0.25, -0.25], sampleRate: 48000 };
  } };
  const wav = await capturePlayableAudio(page, new Map([[source, Promise.resolve(Buffer.from('encoded-preview'))]]));
  assert.equal(evaluations, 2);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.ok(!wav.includes(Buffer.from('hidden-track-name')));
});

test('model-composed results and partial Music Timeliner results cannot become competitive scores', async () => {
  const browser = fakeBrowser({ shareOnClick: '' });
  await assert.rejects(playDailyGame('krillion', DAILY_PLAYER,
    { decide: async () => ({ action: 'done', shareText: 'Krillion #106\n700' }) },
    { dryRun: true, browserType: browser.browserType }), /without a valid native share/);
  assert.equal(parseDailyResult('musictimeliner', 'Music Timeliner #29\n🟩'), null);
  assert.equal(parseDailyResult('krillion', 'Krillion #106\n701'), null);
  assert.equal(parseDailyResult('krillion', 'Krillion #106\n-1'), null);
  assert.equal(parseDailyResult('maptapp', 'www.maptap.gg October 29\nFinal score: 1001'), null);
});

test('inspection needs no model, returns visible data, and closes its temporary profile', async () => {
  const browser = fakeBrowser();
  const result = await playDailyGame('krillion', DAILY_PLAYER, null, { inspect: true, browserType: browser.browserType });
  assert.equal(result.title, 'Krillion'); assert.equal(result.visibleText, 'Visible prompt');
  assert.equal(browser.closed, 1);
  await assert.rejects(access(browser.profile));
});

const observedCodenames = 'CODENAMES DAILY\n29.10.2026\nFERRARI 3 ✅✅❌\nPAINFUL 5 ✅✅✅✅✅\nSOVIET 3 ✅✅✅\nCan you beat this?\nhttps://codenames.game/daily/en';

test('Codenames can finish from its visible native copy popup when clipboard interception is empty', async () => {
  const browser = fakeBrowser({ shareOnClick: '' });
  let copied = false;
  browser.page.mouse.click = async () => { copied = true; };
  browser.page.locator = () => ({ innerText: async () => copied
    ? `CODENAMES\nDAILY\nSHARE RESULTS\n${observedCodenames}` : 'CODENAMES\nDAILY\nSHARE RESULTS' });
  let decisions = 0;
  const result = await playDailyGame('codenames', DAILY_PLAYER, { decide: async () => {
    decisions++;
    return { action: 'click', x: 512, y: 378 };
  } }, { dryRun: true, browserType: browser.browserType });
  assert.equal(result.score, 80);
  assert.equal(result.puzzle, '2026-10-29');
  assert.equal(result.shareText, observedCodenames);
  assert.equal(decisions, 1);
});

test('visible popup extraction rejects board text, incomplete shares and ineligible bonuses', () => {
  assert.equal(visibleCodenamesShare('CODENAMES\nDAILY\nFERRARI\n3'), null);
  assert.equal(visibleCodenamesShare(observedCodenames.replace('https://codenames.game/daily/en', '')), null);
  assert.equal(visibleCodenamesShare(observedCodenames.replace('SOVIET 3 ✅✅✅\n', '')), null);
  assert.equal(visibleCodenamesShare(observedCodenames.replace('Can you beat this?', 'BONUS 1 ✅\nCan you beat this?')), null);
  assert.equal(visibleCodenamesShare(`Other visible text\n${observedCodenames}\nSTATS`), observedCodenames);
});
