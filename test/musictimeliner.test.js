import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMusicTimeliner } from '../src/musictimeliner.js';
import { Store } from '../src/store.js';
import { handleInteraction } from '../src/handlers.js';
import { leaderboard } from '../src/rankings.js';

const share = 'Music Timeliner #29\n\n🟩🟩🟥🟩🟥🟩🟩🟩\n\nhttps://musictimeliner.com/';
const post = (overrides = {}) => ({
  guildId: 'server', channelId: 'channel', id: '100', content: share,
  author: { id: 'alice', username: 'Alice', bot: false }, createdTimestamp: Date.now(), ...overrides,
});

test('Music Timeliner counts green squares in Unicode and Discord alias shares', () => {
  assert.deepEqual(parseMusicTimeliner(share), { puzzle: '29', score: 75 });
  const aliases = share.replaceAll('🟩', ':green_square:').replaceAll('🟥', ':red_square:');
  assert.deepEqual(parseMusicTimeliner(aliases), { puzzle: '29', score: 75 });
  assert.deepEqual(parseMusicTimeliner(share.replaceAll('\n', '\r\n')), { puzzle: '29', score: 75 });
  assert.deepEqual(parseMusicTimeliner('Music Timeliner #029\n🟩 :red_square:\n\n:green_square: 🟥\nhttps://www.musictimeliner.com'), { puzzle: '29', score: 25 });
  assert.deepEqual(parseMusicTimeliner('Music Timeliner #29\n🟩\uFE0F🟥\uFE0F'), { puzzle: '29', score: 12 });
});

test('eight greens earn 100, the final total is rounded down, and oversized results are rejected', () => {
  assert.deepEqual(parseMusicTimeliner('Music Timeliner #29\n🟩🟩🟩🟩🟩🟩🟩🟩'), { puzzle: '29', score: 100 });
  assert.deepEqual(parseMusicTimeliner('Music Timeliner #29\n🟩🟩🟩🟥🟥🟥🟥🟥'), { puzzle: '29', score: 37 });
  assert.equal(parseMusicTimeliner('Music Timeliner #29\n🟩🟩🟩🟩🟩🟩🟩🟩🟩'), null);
  assert.equal(parseMusicTimeliner('Music Timeliner #29\n🟥🟥🟥🟥🟥🟥🟥🟥🟥'), null);
});

test('all-red scores are zero, while missing results and unrelated emojis are ignored', () => {
  assert.deepEqual(parseMusicTimeliner(share.replaceAll('🟩', '🟥')), { puzzle: '29', score: 0 });
  for (const content of [
    'Music Timeliner #29\n\nhttps://musictimeliner.com',
    'Music Timeliner #29\nhttps://musictimeliner.com\n🟩🟥',
    share.replace('Music Timeliner', 'Another game'),
    share.replace('#29', '#29foo'), share.replace('#29', '#99999999999999999999'),
    share.replace('🟩🟩🟥🟩🟥🟩🟩🟩', 'Score: 6'),
    share.replace('🟩🟩🟥🟩🟥🟩🟩🟩', '🟩🟨🟥'),
  ]) assert.equal(parseMusicTimeliner(content), null);
});

test('Music Timeliner submissions support duplicate imports, edits, deletes, and standings', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    assert.equal(store.game('server', 'musictimeliner').parser, 'musictimeliner');
    assert.equal(store.ingest(post()), 1);
    store.ingest(post());
    assert.equal(store.submissions('server').length, 1);
    store.ingest(post({ id: '101', author: { id: 'bob', username: 'Bob', bot: false }, content: share.replaceAll('🟩', '🟥') }));
    const ranked = leaderboard(store.submissions('server'), store.games('server', true), 'musictimeliner');
    assert.equal(ranked[0].userId, 'alice');
    assert.equal(ranked[0].points, 75);
    assert.equal(ranked[1].points, 0);
    assert.equal(store.submissions('other-server').length, 0);
    store.ingest(post({ content: share.replaceAll('🟥', '🟩') }));
    assert.equal(store.submissions('server').find((row) => row.user_id === 'alice').score, 100);
    store.ingest(post({ content: 'Music Timeliner #29\nhttps://musictimeliner.com' }));
    assert.equal(store.submissions('server').length, 1);
    store.removeMessage('server', '101');
    assert.equal(store.submissions('server').length, 0);
  } finally { store.close(); }
});

test('restart adds Music Timeliner to existing servers and retains scores and disabled settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-games-music-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    store.track('server', 'channel');
    // Simulate a database created before Music Timeliner was introduced.
    store.db.prepare("DELETE FROM games WHERE key='musictimeliner'").run();
    store.close();
    store = new Store(path);
    assert.equal(store.game('server', 'musictimeliner').direction, 'higher');
    store.ingest(post());
    store.setEnabled('server', 'musictimeliner', false);
    store.close();
    store = new Store(path);
    assert.equal(store.game('server', 'musictimeliner').enabled, 0);
    store.ingest(post());
    store.setEnabled('server', 'musictimeliner', true);
    assert.equal(store.submissions('server')[0].score, 75);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('Music Timeliner score, leaderboard, game list, and autocomplete commands work', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    store.ingest(post());
    let reply;
    const interaction = {
      guildId: 'server', commandName: 'score', user: { id: 'alice' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      deferReply: async () => {}, editReply: async (value) => { reply = value; },
      options: {
        getString: (name) => name === 'game' ? 'musictimeliner' : null,
        getUser: () => null, getInteger: () => null, getSubcommand: () => 'list', getFocused: () => 'music',
      },
    };
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].description, /75 pts\*\*\n\u20031 game/);
    interaction.commandName = 'leaderboard';
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].title, /Music Timeliner leaderboard/);
    assert.match(reply.embeds[0].description, /75 pts\*\*\n\u20031 game\n\u200375 average pts/);
    interaction.commandName = 'game';
    await handleInteraction(interaction, store);
    assert.match(reply.content, /12\.5 points per green square.*maximum 100.*rounded down/);
    assert.doesNotMatch(reply.content, /\{squares\}/);
    interaction.isAutocomplete = () => true;
    interaction.respond = async (value) => { reply = value; };
    await handleInteraction(interaction, store);
    assert.equal(reply[0].value, 'musictimeliner');
  } finally { store.close(); }
});
