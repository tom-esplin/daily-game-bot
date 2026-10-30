import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { normalizeScore, leaderboard } from '../../src/daily-game-tracker/rankings.js';
import { Store } from '../../src/daily-game-tracker/store.js';
import { handleInteraction } from '../../src/daily-game-tracker/handlers.js';
import { commands } from '../../src/daily-game-tracker/commands.js';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GAME_SCORE_RANGES } from '../../src/daily-game-tracker/scoring-config.js';

test('scores use fixed game ranges, stay within 0–100, and invert lower-is-better games', () => {
  assert.equal(normalizeScore(350, { key: 'krillion', direction: 'higher' }), 50);
  assert.equal(normalizeScore(434, { key: 'maptapp', direction: 'higher' }), 43.4);
  assert.equal(normalizeScore(700, { key: 'krillion', direction: 'higher' }), 100);
  assert.equal(normalizeScore(-10, { key: 'krillion', direction: 'higher' }), 0);
  assert.equal(normalizeScore(900, { key: 'krillion', direction: 'higher' }), 100);
  const wordle = { key: 'wordle', direction: 'lower', score_min: 1, score_max: 6 };
  assert.equal(normalizeScore(1, wordle), 100);
  assert.equal(normalizeScore(6, wordle), 0);
  assert.equal(normalizeScore(3, wordle), 60);
  assert.throws(() => normalizeScore(1, { ...wordle, score_max: 1 }), /Invalid scoring range/);
});

test('overall totals converted scores and game leaderboards total native scores', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    const games = store.games('server', true);
    const rows = [
      { game_key: 'krillion', puzzle: '1', user_id: 'alice', score: 350 },
      { game_key: 'maptapp', puzzle: '2026-10-26', user_id: 'alice', score: 434 },
      { game_key: 'musictimeliner', puzzle: '29', user_id: 'alice', score: 75 },
      { game_key: 'codenames', puzzle: '2026-10-26', user_id: 'alice', score: 100 },
    ];
    assert.ok(Math.abs(leaderboard(rows, games)[0].points - 268.4) < 1e-9);
    assert.equal(leaderboard(rows, games, 'krillion')[0].points, 350);
    assert.equal(leaderboard(rows, games, 'maptapp')[0].points, 434);
    rows.push({ game_key: 'krillion', puzzle: '2', user_id: 'alice', score: 700 });
    assert.ok(Math.abs(leaderboard(rows, games)[0].points - 368.4) < 1e-9);
    assert.equal(leaderboard(rows, games, 'krillion')[0].points, 1050);
    rows.push({ game_key: 'krillion', puzzle: '1', user_id: 'bob', score: 700 });
    assert.ok(Math.abs(leaderboard(rows, games).find((player) => player.userId === 'alice').points - 368.4) < 1e-9);
  } finally { store.close(); }
});

test('per-game lower scores rank first while overall normalized scores rank highest first', () => {
  const games = [{ key: 'wordle', direction: 'lower', score_min: 1, score_max: 6 }];
  const rows = [
    { game_key: 'wordle', puzzle: '1', user_id: 'alice', score: 3 },
    { game_key: 'wordle', puzzle: '1', user_id: 'bob', score: 5 },
  ];
  assert.deepEqual(leaderboard(rows, games, 'wordle').map((player) => player.points), [3, 5]);
  assert.equal(leaderboard(rows, games)[0].userId, 'alice');
  assert.equal(leaderboard(rows, games)[0].points, 60);
});

test('code ranges override legacy database settings and apply to existing scores after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-games-scales-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    store.track('server', 'channel');
    store.ingest({ guildId: 'server', channelId: 'channel', id: '100',
      author: { id: 'alice', username: 'Alice', bot: false }, createdTimestamp: 1000,
      content: 'Krillion #100\n350' });
    store.db.exec(`ALTER TABLE games ADD COLUMN score_min REAL NOT NULL DEFAULT 0;
      ALTER TABLE games ADD COLUMN score_max REAL NOT NULL DEFAULT 100;
      UPDATE games SET score_max=9999 WHERE key='krillion';`);
    store.close();
    store = new Store(path);
    assert.equal(store.game('server', 'krillion').score_max, 700);
    assert.equal(store.game('server', 'maptapp').score_max, 1000);
    assert.equal(store.game('server', 'codenames').score_max, 100);
    assert.equal(store.submissions('server')[0].score, 350);
    assert.equal(leaderboard(store.submissions('server'), store.games('server', true))[0].points, 50);
    GAME_SCORE_RANGES.krillion = [0, 1400];
    store.close();
    store = new Store(path);
    assert.equal(store.game('server', 'krillion').score_max, 1400);
    assert.equal(leaderboard(store.submissions('server'), store.games('server', true))[0].points, 25);
  } finally {
    GAME_SCORE_RANGES.krillion = [0, 700];
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('scale commands and options are removed; game creation uses code ranges and still requires admin', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    let reply;
    const interaction = {
      guildId: 'server', user: { id: 'alice' }, commandName: 'game',
      isAutocomplete: () => false, isChatInputCommand: () => true,
      memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
      deferReply: async (value) => assert.equal(value.flags, MessageFlags.Ephemeral),
      editReply: async (value) => { reply = value; },
      options: { getSubcommand: () => 'scale', getString: () => 'krillion',
        getNumber: (name) => name === 'min-score' ? 0 : 1400 },
    };
    await assert.rejects(handleInteraction(interaction, store), /Unknown game command/);
    assert.equal(store.game('server', 'krillion').score_max, 700);
    assert.equal(store.game('server', 'krillion').enabled, 1);
    interaction.memberPermissions.has = () => false;
    await assert.rejects(handleInteraction(interaction, store), /Manage Server/);
    interaction.memberPermissions.has = () => true;
    interaction.options = {
      getSubcommand: () => 'add',
      getString: (name) => ({ key: 'wordle', name: 'Wordle', template: 'Wordle {puzzle} {score}/6', direction: 'lower' })[name],
      getNumber: (name) => name === 'min-score' ? 1 : 6,
    };
    await handleInteraction(interaction, store);
    assert.equal(store.game('server', 'wordle').score_min, 1);
    assert.equal(store.game('server', 'wordle').score_max, 6);
    assert.match(reply.content, /Added/);
    const game = commands.find((command) => command.name === 'game');
    assert.equal(game.options.some((option) => option.name === 'scale'), false);
    assert.equal(game.options.find((option) => option.name === 'add').options.some((option) => ['min-score', 'max-score'].includes(option.name)), false);
  } finally { store.close(); }
});
