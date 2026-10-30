import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Collection } from 'discord.js';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daily-game-tracker/store.js';
import { handleInteraction } from '../../src/daily-game-tracker/handlers.js';
import { commands } from '../../src/daily-game-tracker/commands.js';

const message = (overrides = {}) => ({ guildId: 'server', channelId: 'a', id: '100',
  content: 'Krillion #100\n350', createdTimestamp: 1000,
  author: { id: 'alice', username: 'Alice', bot: false }, ...overrides });

function interaction(commandName, options = {}) {
  return {
    guildId: 'server', commandName,
    isAutocomplete: () => false, isChatInputCommand: () => true,
    memberPermissions: { has: () => true },
    deferReply: async () => {}, editReply: async function (value) { this.result = value; },
    options: { getInteger: () => null, getChannel: () => null, ...options },
    client: { user: { id: 'bot' } },
  };
}

test('tracking multiple channels is additive, idempotent, isolated by server, and deduplicates cross-posts', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.track('server', 'a'), true);
    assert.equal(store.track('server', 'b'), true);
    assert.equal(store.track('server', 'a'), false);
    assert.deepEqual(store.channels('server'), ['a', 'b']);
    assert.deepEqual(store.channels('other-server'), []);
    store.ingest(message());
    store.ingest(message({ channelId: 'b', id: '101', content: 'Krillion #100\n500', createdTimestamp: 2000 }));
    store.ingest(message({ channelId: 'untracked', id: '102', content: 'Krillion #101\n700' }));
    assert.equal(store.submissions('server').length, 1);
    assert.equal(store.submissions('server')[0].score, 500);
    store.removeMessage('server', '101');
    assert.equal(store.submissions('server')[0].score, 350);
    store.ingest(message({ channelId: 'b', id: '103', content: 'Krillion #101\n600' }));
    assert.equal(store.submissions('server').length, 2);
    assert.equal(store.untrack('server', 'b'), true);
    assert.equal(store.untrack('server', 'b'), false);
    assert.equal(store.isTracked('server', 'b'), false);
    assert.equal(store.ingest(message({ channelId: 'b', id: '104' })), 0);
    assert.equal(store.submissions('server').length, 2);
  } finally { store.close(); }
});

test('legacy channel migration runs once and untracking survives restarts without resurrecting old settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-games-channels-'));
  const path = join(directory, 'test.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE settings (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL);
    INSERT INTO settings VALUES ('server', 'a');`);
  legacy.close();
  let store;
  try {
    store = new Store(path);
    assert.deepEqual(store.channels('server'), ['a']);
    store.ingest(message());
    store.track('server', 'b');
    store.untrack('server', 'a');
    store.close();
    store = new Store(path);
    assert.deepEqual(store.channels('server'), ['b']);
    assert.equal(store.submissions('server')[0].score, 350);
    store.untrack('server', 'b');
    store.close();
    store = new Store(path);
    assert.deepEqual(store.channels('server'), []);
    assert.equal(store.submissions('server').length, 1);
  } finally {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('channel commands add, list, and remove channels with permissions and pagination', async () => {
  const store = new Store(':memory:');
  try {
    const channel = { id: 'a', permissionsFor: () => ({ has: () => true }) };
    const add = interaction('track', { getChannel: () => channel });
    await handleInteraction(add, store);
    assert.match(add.result.content, /Now tracking/);
    await handleInteraction(add, store);
    assert.match(add.result.content, /Already tracking/);
    for (let index = 0; index < 40; index++) store.track('server', `channel-${index}`);
    assert.equal(store.channels('server').length, 41);
    const list = interaction('channels', { getInteger: () => 2 });
    await handleInteraction(list, store);
    assert.match(list.result.content, /Tracked channels \(41\)/);
    assert.match(list.result.content, /Page 2\/3/);
    assert.equal(list.result.content.match(/<#/g).length, 20);
    const remove = interaction('untrack', { getChannel: () => channel });
    await handleInteraction(remove, store);
    assert.equal(store.isTracked('server', 'a'), false);
    assert.match(remove.result.content, /scores are retained/);
    add.memberPermissions.has = () => false;
    await assert.rejects(handleInteraction(add, store), /Manage Server/);
    add.memberPermissions.has = () => true;
    channel.permissionsFor = () => ({ has: () => false });
    await assert.rejects(handleInteraction(add, store), /View Channel/);
    assert.equal(store.isTracked('server', 'a'), false);
    assert.ok(commands.some((command) => command.name === 'untrack'));
    assert.ok(commands.some((command) => command.name === 'channels'));
  } finally { store.close(); }
});

test('backfill scans every tracked channel, applies the limit per channel, and optionally selects one', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'a');
    store.track('server', 'b');
    const requests = [];
    const channels = Object.fromEntries(['a', 'b'].map((id, index) => [id, {
      isTextBased: () => true,
      messages: { fetch: async (options) => {
        requests.push(id);
        if (options.before) return new Collection();
        return new Collection([[`${index + 100}`, message({ channelId: id, id: `${index + 100}`, content: `Krillion #${index + 100}\n350` })]]);
      } },
    }]));
    const job = interaction('backfill', { getInteger: () => 1 });
    job.guild = { channels: { fetch: async (id) => channels[id] } };
    await handleInteraction(job, store);
    assert.deepEqual(requests, ['a', 'b']);
    assert.equal(store.submissions('server').length, 2);
    assert.match(job.result.content, /Scanned 2 messages.*across 2\/2 channels/);
    requests.length = 0;
    job.options.getChannel = () => ({ id: 'b' });
    await handleInteraction(job, store);
    assert.deepEqual(requests, ['b']);
    assert.equal(store.submissions('server').length, 2);
    job.options.getChannel = () => ({ id: 'not-tracked' });
    await assert.rejects(handleInteraction(job, store), /not tracked/);
  } finally { store.close(); }
});

test('unavailable channels do not block backfill of the other tracked channels', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'a');
    store.track('server', 'b');
    const job = interaction('backfill', { getInteger: () => 1 });
    job.guild = { channels: { fetch: async (id) => {
      if (id === 'a') throw new Error('Missing access');
      return { isTextBased: () => true, messages: { fetch: async () => new Collection([['100', message({ channelId: 'b' })]]) } };
    } } };
    await handleInteraction(job, store);
    assert.equal(store.submissions('server').length, 1);
    assert.match(job.result.content, /across 1\/2 channels/);
    assert.match(job.result.content, /Could not finish 1 channels: <#a>/);
  } finally { store.close(); }
});
