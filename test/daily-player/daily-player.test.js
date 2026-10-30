import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Collection } from 'discord.js';
import { Store } from '../../src/daily-game-tracker/store.js';
import { DAILY_PLAYER } from '../../src/daily-player/daily-player-config.js';
import { dailyPlayerWindow, runDailyPlayer, normalizedChannelName, removeDailyResultBanners } from '../../src/daily-player/daily-player.js';
import { parseDailyResult } from '../../src/daily-player/daily-results.js';
import { DailyPlayerModel } from '../../src/daily-player/daily-player-model.js';
import { buildLeaderboardView } from '../../src/daily-game-tracker/leaderboard-view.js';
import { buildUserScoreView } from '../../src/daily-game-tracker/score-view.js';
import { runMonthlyAnnouncements, runMonthlyCelebrations } from '../../src/daily-game-tracker/monthly-announcements.js';

const now = new Date('2026-10-29T17:00:00Z');
const logger = { error() {}, log() {} };
const settings = () => ({ ...DAILY_PLAYER, enabled: true,
  servers: { server: { dailyChannelId: 'daily', codenamesChannelId: 'codenames' } },
  games: Object.fromEntries(Object.entries(DAILY_PLAYER.games).map(([key, game]) => [key, { ...game, enabled: true, verified: true }])) });
const shares = {
  krillion: 'Krillion #106 🦐\n340\n\n🫧🐟🫧🦑🏮🏮🦑',
  codenames: 'CODENAMES DAILY\n29.10.2026\nROMEO 2 ✅✅\nPOWERFUL 3 ✅✅✅\nMEDIEVAL 4 ✅✅✅✅\nSOUND 3 ✅✅✅',
  maptapp: 'www.maptap.gg October 29\n94 97 60 32 9\nFinal score: 434',
  musictimeliner: 'Music Timeliner #29\n🟩🟩🟩🟥🟥🟥🟥🟥\nhttps://musictimeliner.com/',
};
const resultFor = (gameKey) => ({ gameKey, ...parseDailyResult(gameKey, shares[gameKey], now.getTime()), shareText: shares[gameKey] });

function fixture(databasePath = ':memory:') {
  const store = new Store(databasePath);
  store.track('server', 'daily'); store.track('server', 'codenames');
  const sent = [];
  const channels = new Map();
  const client = { user: { id: 'bot' }, users: { fetch: async (id) => ({ username: id }) }, guilds: { cache: new Collection() } };
  const guild = { id: 'server', channels: { fetch: async (id) => id ? channels.get(id) : new Collection(channels) } };
  client.guilds.cache.set('server', guild);
  for (const id of ['daily', 'codenames', 'general']) {
    const history = new Collection();
    const channel = { id, guildId: 'server', name: id, type: 0, history,
      permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => history },
      send: async (payload) => {
        const message = { id: String(100 + sent.length), guildId: 'server', channelId: id,
          author: { id: 'bot', username: 'tracker', bot: true }, content: payload.content ?? '',
          embeds: payload.embeds ?? [], flags: payload.flags ?? 0, createdTimestamp: now.getTime() };
        history.set(message.id, message); sent.push({ payload, message, channelId: id });
        return message;
      },
    };
    channels.set(id, channel);
  }
  const plays = [];
  const play = async (key) => { plays.push(key); return resultFor(key); };
  const modelFactory = () => ({ preflight: async () => {} });
  const run = (options = {}) => runDailyPlayer(client, store, { settings: settings(), now, logger, play, modelFactory, ...options });
  return { store, client, channels, sent, plays, run, play, modelFactory };
}

test('daily window uses Denver 11 am including DST and year boundaries', () => {
  assert.equal(dailyPlayerWindow(new Date('2026-10-29T16:59:59Z')), null);
  assert.equal(dailyPlayerWindow(now), '2026-10-29');
  assert.equal(dailyPlayerWindow(new Date('2026-11-02T17:59:59Z')), null);
  assert.equal(dailyPlayerWindow(new Date('2026-11-02T18:00:00Z')), '2026-11-02');
  assert.equal(dailyPlayerWindow(new Date('2027-01-01T06:59:00Z')), '2026-12-31');
  assert.equal(dailyPlayerWindow(new Date('2027-01-01T07:00:00Z')), null);
});

test('daily player is opt-in and ignores games without verification', async () => {
  const f = fixture();
  try {
    await f.run({ settings: { ...DAILY_PLAYER, enabled: false } });
    const config = settings();
    for (const game of Object.values(config.games)) game.verified = false;
    await f.run({ settings: config });
    await f.run({ now: new Date('2026-10-29T16:00:00Z') });
    assert.equal(f.plays.length, 0); assert.equal(f.sent.length, 0);
  } finally { f.store.close(); }
});

test('plays once, routes Codenames separately, records real scores, and renders the AI alias', async () => {
  const f = fixture();
  try {
    await f.run(); await f.run();
    assert.equal(f.plays.length, 4); assert.equal(f.sent.length, 4);
    assert.equal(f.sent.find((entry) => entry.payload.content.includes('CODENAMES DAILY')).channelId, 'codenames');
    assert.ok(f.sent.filter((entry) => !entry.payload.content.includes('CODENAMES DAILY')).every((entry) => entry.channelId === 'daily'));
    const rows = f.store.submissions('server');
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.user_id === 'bot' && row.username === 'lnklingbot'));
    assert.equal(rows.find((row) => row.game_key === 'musictimeliner').score, 37);
    assert.match(buildLeaderboardView(f.store, 'server', { ownerId: 'alice', now }).embeds[0].description, /\*\*lnklingbot\*\*/);
    assert.match(buildUserScoreView(f.store, 'server', { userId: 'bot', now }).embeds[0].description, /\*\*lnklingbot\*\*/);
    assert.deepEqual(f.sent[0].payload.allowedMentions, { parse: [] });
    assert.equal(f.sent[0].payload.embeds, undefined);
    assert.equal(f.sent[0].payload.flags, 4);
  } finally { f.store.close(); }
});

test('failed sends retry without replay and later disabling/untracking prevents delivery', async () => {
  const f = fixture();
  try {
    const original = f.channels.get('daily').send;
    f.channels.get('daily').send = async () => { throw new Error('offline'); };
    await f.run();
    assert.equal(f.plays.length, 4); assert.equal(f.store.pendingAIDeliveries().length, 3);
    f.store.setEnabled('server', 'krillion', false);
    f.store.untrack('server', 'daily');
    f.channels.get('daily').send = original;
    await f.run();
    assert.equal(f.sent.length, 1);
    f.store.track('server', 'daily');
    await f.run();
    assert.equal(f.sent.length, 3);
    f.store.setEnabled('server', 'krillion', true);
    await f.run();
    assert.equal(f.sent.length, 4); assert.equal(f.plays.length, 4);
  } finally { f.store.close(); }
});

test('successful Discord sends survive a failed receipt write without duplication', async () => {
  const f = fixture();
  try {
    const complete = f.store.completeAIDelivery.bind(f.store);
    f.store.completeAIDelivery = () => { throw new Error('receipt unavailable'); };
    await f.run();
    assert.equal(f.sent.length, 4); assert.equal(f.store.submissions('server').length, 0);
    f.store.completeAIDelivery = complete;
    await f.run();
    assert.equal(f.sent.length, 4); assert.equal(f.store.submissions('server').length, 4);
  } finally { f.store.close(); }
});

test('old daily result banners are removed from saved messages once without changing their content', async () => {
  const f = fixture();
  try {
    await f.run();
    const job = f.store.db.prepare("SELECT * FROM ai_deliveries WHERE game_key='codenames'").get();
    f.store.db.prepare('DELETE FROM app_migrations WHERE name=?').run(`ai-result-format-v2:${job.guild_id}:${job.message_id}`);
    const message = f.sent.find((entry) => entry.message.id === job.message_id).message;
    const originalContent = message.content;
    message.embeds = [{ footer: { text: `AI daily result · codenames · ${job.puzzle}` } }];
    let edits = 0;
    message.edit = async (payload) => { edits++; message.embeds = payload.embeds; };
    f.channels.get('codenames').messages.fetch = async (id) => id ? message : f.channels.get('codenames').history;
    await removeDailyResultBanners(f.client, f.store, { settings: settings(), logger });
    await removeDailyResultBanners(f.client, f.store, { settings: settings(), logger });
    assert.equal(edits, 1);
    assert.deepEqual(message.embeds, []);
    assert.equal(message.content, originalContent);
    assert.equal(f.store.submissions('server').length, 4);
  } finally { f.store.close(); }
});

test('all existing game posts get the corrected name and URL preview suppression even after old cleanup', async () => {
  const f = fixture();
  try {
    await f.run();
    f.store.db.prepare("DELETE FROM app_migrations WHERE name LIKE 'ai-result-format-v2:%'").run();
    const jobs = f.store.db.prepare('SELECT * FROM ai_deliveries').all();
    let edits = 0;
    for (const job of jobs) {
      f.store.db.prepare('INSERT OR IGNORE INTO app_migrations VALUES (?)').run(`ai-result-banner:${job.guild_id}:${job.message_id}`);
      const message = f.sent.find((entry) => entry.message.id === job.message_id).message;
      message.content = message.content.replace('lnklingbot', 'lnklingblot');
      message.embeds = [{ type: 'link', url: 'https://example.com/preview' }];
      message.flags = 0;
      message.edit = async (payload) => { edits++; Object.assign(message, payload); };
    }
    for (const channel of f.channels.values()) channel.messages.fetch = async (id) => id ? channel.history.get(id) : channel.history;
    await removeDailyResultBanners(f.client, f.store, { settings: settings(), logger });
    await removeDailyResultBanners(f.client, f.store, { settings: settings(), logger });
    assert.equal(edits, 4);
    assert.ok(f.sent.every((entry) => entry.message.content.startsWith('**lnklingbot · AI player**')));
    assert.ok(f.sent.every((entry) => entry.message.flags === 4 && entry.message.embeds.length === 0));
    assert.equal(f.store.submissions('server').length, 4);
  } finally { f.store.close(); }
});

test('delivery recovery recognizes the previous player label without reposting', async () => {
  const f = fixture();
  try {
    const complete = f.store.completeAIDelivery.bind(f.store);
    f.store.completeAIDelivery = () => { throw new Error('receipt failed'); };
    await f.run();
    for (const entry of f.sent) entry.message.content = entry.message.content.replace('lnklingbot', 'lnklingblot');
    f.store.completeAIDelivery = complete;
    await f.run();
    assert.equal(f.sent.length, 4);
    assert.equal(f.store.submissions('server').length, 4);
  } finally { f.store.close(); }
});

test('API preflight failures do not consume attempts; game failures never replay or block other games', async () => {
  const f = fixture();
  try {
    await f.run({ modelFactory: () => ({ preflight: async () => { throw new Error('No access'); } }) });
    assert.equal(f.store.dailyRun('2026-10-29', 'krillion'), undefined);
    await f.run({ play: async (key) => { if (key === 'krillion') throw new Error('timer expired'); return f.play(key); } });
    assert.equal(f.store.dailyRun('2026-10-29', 'krillion').status, 'failed');
    await f.run();
    assert.equal(f.sent.length, 3); assert.equal(f.plays.length, 3);
  } finally { f.store.close(); }
});

test('unknown bots and fabricated shares cannot enter the AI ingestion path; backfill recovers only receipts', async () => {
  const f = fixture();
  try {
    await f.run();
    const message = f.sent[0].message;
    assert.equal(f.store.ingest({ ...message, id: 'forged' }), 0);
    assert.equal(f.store.ingest({ ...message, author: { id: 'other', bot: true } }), 0);
    f.store.removeMessage('server', message.id);
    assert.equal(f.store.ingest(message), 1);
    assert.throws(() => f.store.ingest({ ...message, content: 'Krillion #106\n700' }), /mismatch/);
    assert.equal(f.store.submissions('server').length, 4);
  } finally { f.store.close(); }
});

test('one gameplay result is shared across configured servers without leaking human scores', async () => {
  const f = fixture();
  try {
    f.store.track('second', 'other');
    const source = f.channels.get('daily');
    const other = { ...source, id: 'other', guildId: 'second', messages: { fetch: async () => new Collection() },
      send: async (payload) => ({ id: `second-${payload.content.slice(0, 100)}`, channelId: 'other', guildId: 'second',
        author: { id: 'bot', bot: true }, content: payload.content, embeds: payload.embeds || [], createdTimestamp: now.getTime() }) };
    f.client.guilds.cache.set('second', { id: 'second', channels: { fetch: async () => other } });
    const config = settings(); config.servers.second = { dailyChannelId: 'other', codenamesChannelId: 'other' };
    await f.run({ settings: config });
    assert.equal(f.plays.length, 4);
    assert.equal(f.store.submissions('second').length, 4);
    assert.equal(f.store.submissions('server').length, 4);
  } finally { f.store.close(); }
});

test('stale attempts fail safely, claims are exclusive, and a puzzle cannot be completed twice', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.claimDailyRun('2026-10-29', 'krillion', 1000, 1000), true);
    assert.equal(store.claimDailyRun('2026-10-29', 'krillion', 2000, 1000), false);
    store.expireDailyRuns(100000, 1000);
    assert.equal(store.dailyRun('2026-10-29', 'krillion').status, 'failed');
    assert.equal(store.claimDailyRun('2026-10-29', 'krillion', 100000, 1000), false);
    assert.equal(store.claimDailyRun('2026-10-30', 'krillion', 100000, 1000), true);
    store.finishDailyRun('2026-10-30', 'krillion', resultFor('krillion'), now.getTime());
    store.claimDailyRun('2026-10-31', 'krillion', now.getTime(), 1000);
    assert.throws(() => store.finishDailyRun('2026-10-31', 'krillion', resultFor('krillion'), now.getTime()), /UNIQUE/);
    assert.throws(() => store.finishDailyRun('2026-10-31', 'krillion', { ...resultFor('krillion'), score: 700 }, now.getTime()), /Invalid/);
  } finally { store.close(); }
});

function human(store, id, score) {
  store.ingest({ guildId: 'server', channelId: 'daily', id, author: { id, username: id, bot: false },
    content: `Krillion #106\n${score}`, createdTimestamp: now.getTime() });
}

test('monthly AI celebration is separate, uses strict overall totals, and is sent only once', async () => {
  const f = fixture();
  try {
    const config = settings();
    for (const key of ['codenames', 'maptapp', 'musictimeliner']) config.games[key].enabled = false;
    await f.run({ settings: config });
    human(f.store, 'winner', 700); human(f.store, 'tie', 340); human(f.store, 'loser', 100);
    const due = new Date('2026-11-01T00:00:00Z');
    await runMonthlyAnnouncements(f.client, f.store, { now: due, logger });
    await runMonthlyAnnouncements(f.client, f.store, { now: due, logger });
    const general = f.sent.filter((entry) => entry.channelId === 'general');
    assert.equal(general.length, 2);
    assert.match(general[0].payload.embeds[0].description, /lnklingbot/);
    assert.match(general[1].payload.embeds[0].title, /You beat lnklingbot/);
    assert.match(general[1].payload.embeds[0].description, /<@winner>/);
    assert.doesNotMatch(general[1].payload.embeds[0].description, /<@tie>|<@loser>/);
    assert.deepEqual(general[1].payload.allowedMentions, { parse: [] });
  } finally { f.store.close(); }
});

test('celebrations skip missing AI results and retry a frozen snapshot independently', async () => {
  const f = fixture();
  try {
    human(f.store, 'winner', 700);
    await runMonthlyCelebrations(f.client, f.store, { now: new Date('2026-11-01T00:00:00Z'), logger });
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.celebration('server', '2026-10').payload_json, 'null');
    // A fresh month with a frozen pending celebration can be retried after rollover.
    f.store.queueCelebration('server', '2026-11', { embeds: [{ title: 'Frozen', footer: { text: 'frozen' } }] }, now.getTime());
    const original = f.channels.get('general').send;
    f.channels.get('general').send = async () => { throw new Error('offline'); };
    await runMonthlyCelebrations(f.client, f.store, { now: new Date('2026-12-02T00:00:00Z'), logger });
    assert.equal(f.store.pendingCelebrations('server').length, 1);
    f.channels.get('general').send = original;
    await runMonthlyCelebrations(f.client, f.store, { now: new Date('2026-12-02T00:00:00Z'), logger });
    assert.equal(f.sent.length, 1); assert.equal(f.store.pendingCelebrations('server').length, 0);
  } finally { f.store.close(); }
});

test('model client uses Sol medium and audio-only bytes, without tools, hidden metadata or secrets in errors', async () => {
  const requests = [];
  const usage = [];
  const model = new DailyPlayerModel({ ...DAILY_PLAYER, audioBackend: 'openai' }, { apiKey: 'test-secret', onUsage: (record) => usage.push(record),
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      return { ok: true, json: async () => url.endsWith('responses')
        ? { output: [{ content: [{ type: 'output_text', text: '{"action":"wait"}' }] }], usage: { total_tokens: 42 } }
        : { choices: [{ message: { content: 'Possibly 1980s; uncertain.' } }], usage: { total_tokens: 8 } } };
    } });
  await model.preflight();
  await model.decide({ gameKey: 'musictimeliner', screenshot: Buffer.from('png'), visibleText: 'Play', history: [], feedback: '' });
  const observations = await model.listen(Buffer.from('wav-audio'));
  assert.match(observations, /uncertain/);
  assert.equal(requests[2].body.model, 'gpt-6.1-sol');
  assert.deepEqual(requests[2].body.reasoning, { effort: 'medium' });
  assert.equal(requests[2].body.tools, undefined);
  assert.ok(requests[2].body.text.format.schema.required.includes('decisionSummary'));
  assert.ok(requests[2].body.text.format.schema.required.includes('confidence'));
  assert.equal(requests[3].body.model, 'gpt-audio-1.5');
  assert.equal(requests[3].body.messages[1].content[0].input_audio.data, Buffer.from('wav-audio').toString('base64'));
  assert.equal(usage.length, 2);
  const failing = new DailyPlayerModel({ ...DAILY_PLAYER, audioBackend: 'openai' }, { apiKey: 'test-secret', fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(failing.listen(Buffer.from('x')), (error) => /HTTP 401/.test(error.message) && !error.message.includes('test-secret'));
});

test('completed attempts, verified score identity and delivery receipts survive a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-player-db-'));
  const path = join(directory, 'test.sqlite');
  const f = fixture(path);
  let reopened;
  try {
    await f.run();
    f.store.close();
    reopened = new Store(path);
    await runDailyPlayer(f.client, reopened, { settings: settings(), now, logger, play: f.play, modelFactory: f.modelFactory });
    assert.equal(f.plays.length, 4); assert.equal(f.sent.length, 4);
    assert.equal(reopened.submissions('server').length, 4);
    assert.equal(reopened.isAIPlayer('bot'), true);
    assert.equal(reopened.pendingAIDeliveries().length, 0);
  } finally {
    if (reopened) reopened.close(); else f.store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('celebration recovery does not duplicate a successful send when its receipt failed', async () => {
  const f = fixture();
  try {
    f.store.queueCelebration('server', '2026-10', { embeds: [{ title: 'Celebration', footer: { text: 'test-celebration' } }] }, now.getTime());
    const finish = f.store.finishCelebration.bind(f.store);
    f.store.finishCelebration = () => { throw new Error('receipt write failed'); };
    await runMonthlyCelebrations(f.client, f.store, { now, logger });
    assert.equal(f.sent.length, 1);
    f.store.finishCelebration = finish;
    await runMonthlyCelebrations(f.client, f.store, { now, logger });
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.pendingCelebrations('server').length, 0);
  } finally { f.store.close(); }
});

test('unavailable audio access does not block non-music games or consume the music attempt', async () => {
  const f = fixture();
  try {
    const checked = [];
    await f.run({ modelFactory: () => ({ preflight: async (_signal, { audio }) => {
      checked.push(audio);
      if (audio) throw new Error('Audio model unavailable');
    } }) });
    assert.deepEqual(checked, [false, true]);
    assert.equal(f.plays.length, 3);
    assert.equal(f.store.dailyRun('2026-10-29', 'musictimeliner'), undefined);
    assert.ok(f.plays.includes('krillion'));
    await f.run();
    assert.equal(f.plays.length, 4);
  } finally { f.store.close(); }
});

test('game-specific model preflight skips audio and an audio 404 provides actionable diagnostics', async () => {
  const checked = [];
  const model = new DailyPlayerModel({ ...DAILY_PLAYER, audioBackend: 'openai' }, { apiKey: 'test-secret', fetchImpl: async (url) => {
    checked.push(url);
    return { ok: !url.endsWith(DAILY_PLAYER.audioModel), status: 404 };
  } });
  await model.preflight(undefined, { audio: false });
  assert.equal(checked.length, 1);
  await assert.rejects(model.preflight(), (error) => /HTTP 404/.test(error.message)
    && /--list-models/.test(error.message) && /OPENAI_AUDIO_MODEL/.test(error.message) && !/test-secret/.test(error.message));
});

test('audio model listing shows only accessible audio model IDs without credentials', async () => {
  const model = new DailyPlayerModel(DAILY_PLAYER, { apiKey: 'test-secret', fetchImpl: async () => ({
    ok: true, json: async () => ({ data: [{ id: 'gpt-audio-mini' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-audio' }] }),
  }) });
  assert.deepEqual(await model.listAudioModels(), ['gpt-audio', 'gpt-audio-mini']);
});

test('inferred channel destinations must match expected live names before playing or posting', async () => {
  const f = fixture();
  try {
    const config = settings();
    config.servers.server.validateChannelNames = true;
    await f.run({ settings: config });
    assert.equal(f.plays.length, 0);
    assert.equal(f.sent.length, 0);
    f.channels.get('daily').name = 'daily-games';
    f.channels.get('codenames').name = 'daily-codenames';
    await f.run({ settings: config });
    assert.equal(f.plays.length, 4);
    assert.equal(f.sent.length, 4);
  } finally { f.store.close(); }
});

test('channel matching accepts emoji decorations and common separators', () => {
  assert.equal(normalizedChannelName('🎮│daily-games'), 'daily-games');
  assert.equal(normalizedChannelName('🕵️・daily_codenames'), 'daily-codenames');
  assert.equal(normalizedChannelName('daily–games'), 'daily-games');
  assert.notEqual(normalizedChannelName('general'), 'daily-games');
});

test('incorrect inferred IDs resolve to uniquely named tracked channels and queue the resolved IDs', async () => {
  const f = fixture();
  try {
    const config = settings();
    config.servers.server = { dailyChannelId: 'general', codenamesChannelId: 'general', validateChannelNames: true };
    f.channels.get('daily').name = '🎮│daily-games';
    f.channels.get('codenames').name = '🕵️│codenames-daily';
    await f.run({ settings: config });
    assert.equal(f.plays.length, 4);
    assert.equal(f.sent.length, 4);
    assert.ok(f.sent.every((entry) => entry.channelId !== 'general'));
    assert.equal(f.sent.find((entry) => entry.payload.content.includes('CODENAMES DAILY')).channelId, 'codenames');
  } finally { f.store.close(); }
});

test('unmatched names report the actual tracked channel names and IDs without playing', async () => {
  const f = fixture();
  try {
    const errors = [];
    const config = settings(); config.servers.server.validateChannelNames = true;
    await f.run({ settings: config, logger: { log() {}, error: (...parts) => errors.push(parts.join(' ')) } });
    assert.equal(f.plays.length, 0);
    assert.ok(errors.some((entry) => entry.includes('#daily (daily)') && entry.includes('#codenames (codenames)')));
  } finally { f.store.close(); }
});
