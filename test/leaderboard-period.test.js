import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionsForPeriod, leaderboardPeriodLabel } from '../src/leaderboard-period.js';
import { leaderboard } from '../src/rankings.js';
import { buildLeaderboardView } from '../src/leaderboard-view.js';
import { handleInteraction } from '../src/handlers.js';
import { Store } from '../src/store.js';
import { commands } from '../src/commands.js';

const timestamp = (value) => Date.parse(value);
const periodMenu = (view) => view.components.at(-2).components[0];
const buttons = (view) => view.components.at(-1).components;

test('monthly filtering uses Denver calendar boundaries, handles DST, and isolates years', () => {
  const rows = [
    { id: 'before', created_at: timestamp('2026-10-01T05:59:59.999Z') },
    { id: 'start', created_at: timestamp('2026-10-01T06:00:00.000Z') },
    { id: 'end', created_at: timestamp('2026-11-01T05:59:59.999Z') },
    { id: 'next', created_at: timestamp('2026-11-01T06:00:00.000Z') },
    { id: 'last-year', created_at: timestamp('2025-10-15T12:00:00Z') },
  ];
  const now = new Date('2026-10-27T12:00:00Z');
  assert.deepEqual(submissionsForPeriod(rows, 'monthly', now).map((row) => row.id), ['start', 'end']);
  assert.equal(submissionsForPeriod(rows, 'alltime', now).length, 5);
  assert.equal(leaderboardPeriodLabel('monthly', now), 'October 2026');
  assert.equal(leaderboardPeriodLabel('alltime', now), 'All Time');
  const december = [{ created_at: timestamp('2026-12-01T06:59:59Z') }, { created_at: timestamp('2026-12-01T07:00:00Z') }];
  assert.deepEqual(submissionsForPeriod(december, 'monthly', new Date('2026-12-15T12:00:00Z')), [december[1]]);
  assert.throws(() => submissionsForPeriod(rows, 'weekly', now), /Monthly or All Time/);
});

test('monthly and all-time totals include every result, normalize overall only, and count daily games', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    const row = (game_key, puzzle, score, date) => ({ game_key, puzzle, score, created_at: timestamp(date), user_id: 'alice' });
    const rows = [
      row('krillion', '1', 350, '2026-10-01T12:00:00Z'),
      row('krillion', '2', 700, '2026-10-02T12:00:00Z'),
      row('maptapp', '2026-10-03', 500, '2026-10-03T12:00:00Z'),
      row('krillion', '0', 700, '2026-09-30T12:00:00Z'),
    ];
    const games = store.games('server', true);
    const monthly = submissionsForPeriod(rows, 'monthly', new Date('2026-10-27T12:00:00Z'));
    const overall = leaderboard(monthly, games)[0];
    assert.equal(overall.points, 200); // 50 + 100 + 50, with no averaging or total cap.
    assert.equal(overall.count, 3);
    assert.equal(leaderboard(monthly, games, 'krillion')[0].points, 1050);
    assert.equal(leaderboard(rows, games)[0].points, 300);
    assert.equal(leaderboard(rows, games, 'krillion')[0].points, 1750);
  } finally { store.close(); }
});

test('monthly cards retain the original message month on backfill and edits', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    const post = {
      guildId: 'server', channelId: 'channel', id: '100',
      author: { id: 'alice', username: 'Alice', bot: false },
      content: 'Krillion #1\n350', createdTimestamp: timestamp('2026-09-30T12:00:00Z'),
    };
    store.ingest(post);
    store.ingest({ ...post, content: 'Krillion #1\n700' });
    const now = new Date('2026-10-27T12:00:00Z');
    const month = buildLeaderboardView(store, 'server', { ownerId: 'alice', now });
    assert.match(month.embeds[0].description, /No scores recorded for this period/);
    const all = buildLeaderboardView(store, 'server', { ownerId: 'alice', now, period: 'alltime' });
    assert.match(all.embeds[0].description, /100 pts\*\*\n\u20031 game\n\u2003100 average pts/);
    assert.equal(store.submissions('server').length, 1);
  } finally { store.close(); }
});

test('period switches reset pages and persist through game changes, navigation, and refresh', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    for (let index = 0; index < 12; index++) store.ingest({
      guildId: 'server', channelId: 'channel', id: String(100 + index),
      author: { id: String(1000 + index), username: 'Player', bot: false },
      content: `Krillion #1\n${index * 10}`, createdTimestamp: Date.now(),
    });
    const press = async (id, values) => {
      const interaction = {
        customId: id, values, guildId: 'server', user: { id: '123' },
        isAutocomplete: () => false, isChatInputCommand: () => false,
        isButton: () => !values, isStringSelectMenu: () => Boolean(values),
        deferUpdate: async () => {}, editReply: async function (value) { this.view = value; },
        reply: async function (value) { this.error = value; },
        followUp: async function (value) { this.error = value; },
      };
      await handleInteraction(interaction, store);
      assert.equal(interaction.error, undefined);
      return interaction.view;
    };
    let view = buildLeaderboardView(store, 'server', { ownerId: '123', page: 2 });
    assert.equal(periodMenu(view).options.find((option) => option.value === 'monthly').default, true);
    view = await press(periodMenu(view).custom_id, ['alltime']);
    assert.match(view.embeds[0].title, /All Time/);
    assert.match(view.embeds[0].footer.text, /Page 1\/3/);
    view = await press(view.components[0].components[0].custom_id, ['krillion']);
    assert.match(view.embeds[0].title, /All Time · Krillion/);
    view = await press(buttons(view)[1].custom_id);
    assert.match(view.embeds[0].footer.text, /Page 2\/3/);
    view = await press(buttons(view)[2].custom_id);
    assert.match(view.embeds[0].title, /All Time · Krillion/);
    assert.match(view.embeds[0].footer.text, /Page 2\/3/);
    view = await press(periodMenu(view).custom_id, ['monthly']);
    assert.match(view.embeds[0].title, /Monthly · Krillion/);
    assert.match(view.embeds[0].footer.text, /Page 1\/3/);
  } finally { store.close(); }
});

test('slash command offers Monthly and All Time and passes the selected period to the card', async () => {
  const definition = commands.find((command) => command.name === 'leaderboard');
  assert.equal(definition.options.some((option) => option.name === 'page'), false);
  assert.deepEqual(definition.options.find((option) => option.name === 'period').choices.map((choice) => choice.value), ['monthly', 'alltime']);
  const store = new Store(':memory:');
  try {
    let view;
    const interaction = {
      guildId: 'server', commandName: 'leaderboard', user: { id: '123' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      options: { getString: (name) => name === 'period' ? 'alltime' : null, getInteger: () => null },
      deferReply: async () => {}, editReply: async (value) => { view = value; },
    };
    await handleInteraction(interaction, store);
    assert.match(view.embeds[0].title, /All Time · Overall/);
    assert.equal(periodMenu(view).options.find((option) => option.value === 'alltime').default, true);
  } finally { store.close(); }
});
