import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daily-game-tracker/store.js';
import { monthlyAnnouncementWindow, runMonthlyAnnouncements } from '../../src/daily-game-tracker/monthly-announcements.js';

const due = new Date('2026-11-01T00:00:00Z'); // October 31, 6 pm in Denver.
const logger = { error: () => {} };

function discord(guildIds = ['server']) {
  const sent = [];
  const history = new Map();
  const channels = new Map();
  const client = {
    user: { id: 'bot' }, users: { fetch: async (id) => ({ username: id }) },
    guilds: { cache: new Collection() },
  };
  for (const guildId of guildIds) {
    const id = `general-${guildId}`;
    history.set(id, new Collection());
    const channel = {
      id, guildId, name: 'general', type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async () => history.get(id) },
      send: async (payload) => {
        const message = { id: String(10000 + sent.length), author: { id: 'bot' },
          embeds: payload.embeds, createdTimestamp: due.getTime() + 1000 };
        sent.push({ guildId, payload, message });
        history.get(id).set(message.id, message);
        return message;
      },
    };
    channels.set(guildId, channel);
    client.guilds.cache.set(guildId, { id: guildId, channels: {
      fetch: async (channelId) => channelId ? channel : new Collection([[id, channel]]),
    } });
  }
  return { client, sent, channels, history };
}

function score(store, userId, points, { guildId = 'server', id = userId, puzzle = '100',
  createdTimestamp = Date.parse('2026-10-20T12:00:00Z'), username = userId } = {}) {
  store.ingest({ guildId, channelId: 'scores', id, createdTimestamp,
    author: { id: userId, username, bot: false }, content: `Krillion #${puzzle}\n${points}` });
}

test('announcement timing follows Denver month end, leap years, and daylight saving offsets', () => {
  assert.equal(monthlyAnnouncementWindow(new Date('2026-10-31T23:59:59Z')), null);
  assert.deepEqual(monthlyAnnouncementWindow(due), { month: '2026-10', cutoff: due.getTime() });
  assert.equal(monthlyAnnouncementWindow(new Date('2026-10-28T23:00:00Z')), null);
  assert.equal(monthlyAnnouncementWindow(new Date('2026-11-01T07:00:00Z')), null);
  assert.deepEqual(monthlyAnnouncementWindow(new Date('2027-03-01T01:00:00Z')),
    { month: '2027-02', cutoff: Date.parse('2027-03-01T01:00:00Z') });
  assert.equal(monthlyAnnouncementWindow(new Date('2028-02-29T01:00:00Z')), null);
  assert.deepEqual(monthlyAnnouncementWindow(new Date('2028-03-01T01:00:00Z')),
    { month: '2028-02', cutoff: Date.parse('2028-03-01T01:00:00Z') });
});

test('monthly overall top three are announced in general once, with the Easter egg when Gabe loses', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'alice', 700);
    score(store, 'bob', 560);
    score(store, 'carol', 420);
    score(store, 'inklingbot_', 350);
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.content, 'Nice try, Gabe 😈');
    assert.match(sent[0].payload.embeds[0].title, /October 2026 winners/);
    assert.match(sent[0].payload.embeds[0].description, /🥇 <@alice>/);
    assert.match(sent[0].payload.embeds[0].description, /🥈 <@bob>/);
    assert.match(sent[0].payload.embeds[0].description, /🥉 <@carol>/);
    assert.doesNotMatch(sent[0].payload.embeds[0].description, /<@inklingbot_>/);
    assert.equal(sent[0].payload.enforceNonce, true);
    assert.ok(sent[0].payload.nonce.length <= 25);
    assert.deepEqual(sent[0].payload.allowedMentions, { parse: [] });
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'sent');
    await runMonthlyAnnouncements(client, store, { now: new Date(due.getTime() + 60000), logger });
    assert.equal(sent.length, 1);
  } finally { store.close(); }
});

test('current usernames identify Gabe even if the stored username has changed', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'gabe-id', 700, { username: 'old-name' });
    score(store, 'alice', 350);
    client.users.fetch = async (id) => ({ username: id === 'gabe-id' ? 'inklingbot_' : id });
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent[0].payload.content, undefined);
    assert.match(sent[0].payload.embeds[0].description, /<@gabe-id>/);
  } finally { store.close(); }
});

test('monthly winners use total points rather than the all-time average ranking rule', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'alice', 350, { id: 'alice-1', puzzle: '100' });
    score(store, 'alice', 350, { id: 'alice-2', puzzle: '101' });
    score(store, 'bob', 630);
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.ok(sent[0].payload.embeds[0].description.startsWith('🥇 <@alice>'));
    assert.match(sent[0].payload.embeds[0].description, /100 pts.*\n\u20032 games\n\u200350 average pts/);
  } finally { store.close(); }
});

test('stored usernames are used when username fetching fails', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'gabe-id', 700, { username: 'inklingbot_' });
    client.users.fetch = async () => { throw new Error('Offline'); };
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent[0].payload.content, undefined);
  } finally { store.close(); }
});

test('announcements freeze the 6 pm result and exclude later reposts and other months', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'alice', 350, { id: 'early' });
    score(store, 'alice', 700, { id: 'late-copy', createdTimestamp: due.getTime() + 1000 });
    score(store, 'late-only', 700, { createdTimestamp: due.getTime() + 2000 });
    score(store, 'previous-month', 700, { createdTimestamp: Date.parse('2026-09-20T12:00:00Z') });
    assert.equal(store.submissions('server').find((row) => row.user_id === 'alice').score, 700);
    await runMonthlyAnnouncements(client, store, { now: new Date(due.getTime() + 10000), logger });
    const description = sent[0].payload.embeds[0].description;
    assert.match(description, /<@alice>\n\u2003\*\*50 pts/);
    assert.doesNotMatch(description, /late-only|previous-month/);
  } finally { store.close(); }
});

test('no announcement is sent early, and empty months are skipped', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    await runMonthlyAnnouncements(client, store, { now: new Date('2026-10-28T12:00:00Z'), logger });
    assert.equal(sent.length, 0);
    assert.equal(store.monthlyAnnouncement('server', '2026-10'), undefined);
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent.length, 0);
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'empty');
  } finally { store.close(); }
});

test('send failures retry the original snapshot, including after month rollover', async () => {
  const store = new Store(':memory:');
  const { client, sent, channels } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'alice', 350);
    const channel = channels.get('server');
    const send = channel.send;
    channel.send = async () => { throw new Error('Temporary failure'); };
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'pending');
    score(store, 'alice', 700); // Editing the underlying result cannot change the frozen snapshot.
    channel.send = send;
    await runMonthlyAnnouncements(client, store, { now: new Date('2026-11-02T12:00:00Z'), logger });
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.embeds[0].description, /50 pts/);
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'sent');
  } finally { store.close(); }
});

test('a successful send is recovered from history if saving its receipt failed', async () => {
  const store = new Store(':memory:');
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'alice', 700);
    const finish = store.finishMonthlyAnnouncement.bind(store);
    store.finishMonthlyAnnouncement = () => { throw new Error('Receipt write interrupted'); };
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent.length, 1);
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'pending');
    store.finishMonthlyAnnouncement = finish;
    await runMonthlyAnnouncements(client, store, { now: new Date(due.getTime() + 60000), logger });
    assert.equal(sent.length, 1);
    assert.equal(store.monthlyAnnouncement('server', '2026-10').message_id, sent[0].message.id);
  } finally { store.close(); }
});

test('server announcements are isolated, and a permission failure does not block another server', async () => {
  const store = new Store(':memory:');
  const { client, sent, channels } = discord(['server', 'other']);
  try {
    store.track('server', 'scores');
    store.track('other', 'scores');
    score(store, 'alice', 700);
    score(store, 'bob', 350, { guildId: 'other' });
    channels.get('server').permissionsFor = () => ({ has: () => false });
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].guildId, 'other');
    assert.doesNotMatch(sent[0].payload.embeds[0].description, /<@alice>/);
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'pending');
    channels.get('server').permissionsFor = () => ({ has: () => true });
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    assert.equal(sent.length, 2);
  } finally { store.close(); }
});

test('announcement receipts persist through a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-games-announcements-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  const { client, sent } = discord();
  try {
    store.track('server', 'scores');
    score(store, 'alice', 700);
    await runMonthlyAnnouncements(client, store, { now: due, logger });
    store.close();
    store = new Store(path);
    await runMonthlyAnnouncements(client, store, { now: new Date(due.getTime() + 60000), logger });
    assert.equal(sent.length, 1);
    assert.equal(store.monthlyAnnouncement('server', '2026-10').status, 'sent');
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});
