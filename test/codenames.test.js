import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodenames } from '../src/codenames.js';
import { normalizePuzzle, parseSubmission } from '../src/parser.js';
import { Store } from '../src/store.js';
import { leaderboard } from '../src/rankings.js';
import { handleInteraction } from '../src/handlers.js';

const sample = 'CODENAMES DAILY\n\n22.10.2026\n\nROMEO 2 ✅✅\n\nPOWERFUL 3 ✅✅✅\n\nMEDIEVAL 4 ✅✅✅✅\n\nSOUND 3 ✅✅✅';
const post = (overrides = {}) => ({
  guildId: 'server', channelId: 'channel', id: '100', content: sample,
  author: { id: 'alice', username: 'Alice', bot: false },
  createdTimestamp: Date.UTC(2026, 9, 22), ...overrides,
});

test('Codenames sample earns 100 with an unambiguous day-month-year puzzle date', () => {
  assert.deepEqual(parseCodenames(sample), { puzzle: '2026-10-22', score: 100 });
  assert.deepEqual(parseCodenames(sample.replaceAll('\n', '\r\n')), { puzzle: '2026-10-22', score: 100 });
  assert.deepEqual(parseCodenames(sample + '\n\nCan you beat this?\nhttps://codenames.game/daily/en'), { puzzle: '2026-10-22', score: 100 });
  assert.deepEqual(parseCodenames(sample.replaceAll('✅', '✅\uFE0F')), { puzzle: '2026-10-22', score: 100 });
  assert.equal(normalizePuzzle('2.1.2026'), '2026-01-02');
  assert.equal(normalizePuzzle('31.2.2026'), null);
  assert.deepEqual(parseSubmission('Test 22.10.2026\n110', 'Test {puzzle}\n{score}'), { puzzle: '2026-10-22', score: 110 });
});

test('main rounds each contribute 30 points, with a 10 point bonus and flooring of the final total', () => {
  const noBonus = sample.replace('SOUND 3 ✅✅✅', 'SOUND 3 ❌');
  assert.equal(parseCodenames(noBonus).score, 90);
  const partialBonus = sample.replace('SOUND 3 ✅✅✅', 'SOUND 3 ✅✅❌');
  assert.equal(parseCodenames(partialBonus).score, 96);
  const partialMain = sample.replace('MEDIEVAL 4 ✅✅✅✅', 'MEDIEVAL 4 ✅❌');
  assert.equal(parseCodenames(partialMain).score, 77);
  const onlyBonus = sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ❌')
    .replace('POWERFUL 3 ✅✅✅', 'POWERFUL 3 ❌').replace('MEDIEVAL 4 ✅✅✅✅', 'MEDIEVAL 4 ❌');
  assert.equal(parseCodenames(onlyBonus).score, 10);
  assert.equal(parseCodenames(onlyBonus.replace('SOUND 3 ✅✅✅', 'SOUND 3 ❌')).score, 0);
});

test('main rounds have equal weight regardless of target count, and rounding happens after summing', () => {
  const halfFirst = sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ✅❌');
  const halfThird = sample.replace('MEDIEVAL 4 ✅✅✅✅', 'MEDIEVAL 4 ✅✅❌');
  assert.equal(parseCodenames(halfFirst).score, 85);
  assert.equal(parseCodenames(halfThird).score, 85);
  const twoPerfect = sample.replace('MEDIEVAL 4 ✅✅✅✅', 'MEDIEVAL 4 ❌').replace('SOUND 3 ✅✅✅', 'SOUND 3 ❌');
  assert.equal(parseCodenames(twoPerfect).score, 60);
  const exactInteger = sample.replace('MEDIEVAL 4 ✅✅✅✅', 'MEDIEVAL 4 ✅✅❌').replace('SOUND 3 ✅✅✅', 'SOUND 3 ❌');
  assert.equal(parseCodenames(exactInteger).score, 75);
});

test('incomplete, invalid, and unrelated Codenames posts do not become scores', () => {
  for (const content of [
    sample.replace('CODENAMES DAILY', 'Another game'), sample.replace('22.10.2026', '31.02.2026'),
    sample.replace('\n\nSOUND 3 ✅✅✅', ''), sample + '\nEXTRA 1 ✅',
    sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ✅'),
    sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ✅✅✅'),
    sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ❌✅'),
    sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ❌❌'),
    sample.replace('ROMEO 2 ✅✅', 'ROMEO 0 ❌'),
    sample.replace('ROMEO 2 ✅✅', 'ROMEO 2 ???'),
  ]) assert.equal(parseCodenames(content), null);
});

test('Codenames is included automatically, supports corrections, and ranks higher scores first', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    assert.equal(store.game('server', 'codenames').parser, 'codenames');
    assert.equal(store.ingest(post()), 1);
    store.ingest(post());
    assert.equal(store.submissions('server').length, 1);
    store.ingest(post({ id: '101', author: { id: 'bob', username: 'Bob', bot: false }, content: sample.replace('SOUND 3 ✅✅✅', 'SOUND 3 ❌') }));
    const ranked = leaderboard(store.submissions('server'), store.games('server', true), 'codenames');
    assert.equal(ranked[0].userId, 'alice');
    assert.equal(ranked[0].points, 100);
    assert.equal(ranked[1].points, 90);
    store.ingest(post({ content: sample.replace('SOUND 3 ✅✅✅', 'SOUND 3 ❌') }));
    assert.equal(store.submissions('server').find((row) => row.user_id === 'alice').score, 90);
    store.setEnabled('server', 'codenames', false);
    store.track('server', 'channel');
    assert.equal(store.game('server', 'codenames').enabled, 0);
    assert.equal(store.submissions('server').length, 0);
    store.setEnabled('server', 'codenames', true);
    assert.equal(store.submissions('server').length, 2);
  } finally { store.close(); }
});

test('existing databases gain the built-in parser without losing scores or custom games', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-games-codenames-'));
  const path = join(directory, 'test.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE settings (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL);
    CREATE TABLE games (
      guild_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, template TEXT NOT NULL,
      direction TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(guild_id, key)
    );
    INSERT INTO settings VALUES ('server', 'channel');
    INSERT INTO games VALUES ('server', 'custom', 'Custom', 'Test {puzzle} {score}', 'lower', 1);
  `);
  legacy.close();
  let store;
  try {
    store = new Store(path);
    assert.deepEqual(store.channels('server'), ['channel']);
    assert.equal(store.game('server', 'custom').parser, 'template');
    assert.equal(store.game('server', 'custom').direction, 'lower');
    assert.equal(store.game('server', 'codenames').parser, 'codenames');
    store.ingest(post({ content: 'Test 10 5' }));
    store.ingest(post({ id: '101' }));
    store.setEnabled('server', 'codenames', false);
    store.close();
    store = new Store(path);
    assert.equal(store.game('server', 'codenames').enabled, 0);
    assert.equal(store.submissions('server')[0].score, 5);
    store.setEnabled('server', 'codenames', true);
    assert.equal(store.submissions('server').length, 2);
  } finally {
    store?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('score lookup and game list expose Codenames with the calculated score', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    store.ingest(post());
    let reply;
    const interaction = {
      guildId: 'server', commandName: 'score', user: { id: 'alice' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      deferReply: async () => {}, editReply: async (value) => { reply = value; },
      options: { getString: (name) => name === 'game' ? 'codenames' : '22.10.2026', getUser: () => null },
    };
    await handleInteraction(interaction, store);
    assert.match(reply.content, /2026-10-22: \*\*100\*\*/);
    interaction.commandName = 'game';
    interaction.options.getSubcommand = () => 'list';
    await handleInteraction(interaction, store);
    assert.match(reply.content, /Codenames Daily/);
    assert.match(reply.content, /30 points.*10 bonus points.*rounded down.*maximum 100/);
    assert.doesNotMatch(reply.content, /\{rounds\}/);
  } finally { store.close(); }
});
