import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { Store } from '../src/store.js';
import { buildLeaderboardView } from '../src/leaderboard-view.js';
import { handleInteraction } from '../src/handlers.js';

function seed(store, count = 12) {
  store.track('server', 'channel');
  for (let index = 0; index < count; index++) store.ingest({
    guildId: 'server', channelId: 'channel', id: String(100 + index),
    author: { id: String(1000 + index), username: `Player ${index}`, bot: false },
    content: `Krillion #100 🦐\n${index * 10}`, createdTimestamp: Date.now(),
  });
}

function component(customId, values) {
  return {
    customId, guildId: 'server', user: { id: '123' }, values,
    isButton: () => !values, isStringSelectMenu: () => Boolean(values),
    isAutocomplete: () => false, isChatInputCommand: () => false,
    deferUpdate: async function () { this.acknowledged = true; },
    editReply: async function (value) { this.result = value; },
    reply: async function (value) { this.denied = value; },
    followUp: async function (value) { this.error = value; },
  };
}

const buttons = (view) => view.components.at(-1).components;

test('player blocks show total, game count, and the average for overall and individual games', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    for (const [index, content] of ['Krillion #1\n350', 'Krillion #2\n700', 'www.maptap.gg October 26\nFinal score: 500'].entries()) {
      store.ingest({ guildId: 'server', channelId: 'channel', id: String(100 + index),
        author: { id: 'alice', username: 'Alice', bot: false }, createdTimestamp: Date.now(), content });
    }
    const overall = buildLeaderboardView(store, 'server', { ownerId: 'alice' });
    assert.equal(overall.embeds[0].description, '🥇 <@alice>\n\u2003**200 pts**\n\u20033 games\n\u200366.67 average pts');
    const game = buildLeaderboardView(store, 'server', { ownerId: 'alice', gameKey: 'krillion' });
    assert.equal(game.embeds[0].description, '🥇 <@alice>\n\u2003**1050 pts**\n\u20032 games\n\u2003525 average pts');
    assert.ok(overall.embeds[0].description.length <= 4096);
  } finally { store.close(); }
});

test('leaderboard card shows medals, score details, timestamp, and page boundary controls', () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const now = new Date();
    const view = buildLeaderboardView(store, 'server', { ownerId: '123', now });
    assert.equal(view.embeds[0].title, '🏆 Monthly · Overall leaderboard');
    assert.match(view.embeds[0].description, /🥇 <@1011>\n\u2003\*\*15\.71 pts\*\*\n\u20031 game\n\u200315\.71 average pts/);
    assert.equal(view.embeds[0].description.split('\n\n').length, 5);
    assert.equal(view.embeds[0].description.match(/<@/g).length, 5);
    assert.match(view.embeds[0].footer.text, /Page 1\/3 · 12 players/);
    assert.equal(view.embeds[0].timestamp, now.toISOString());
    assert.equal(buttons(view)[0].disabled, true);
    assert.equal(buttons(view)[1].disabled, false);
    assert.equal(view.components[0].components[0].options[0].default, true);
    assert.deepEqual(view.allowedMentions, { parse: [] });
    const last = buildLeaderboardView(store, 'server', { ownerId: '123', page: 3, gameKey: 'krillion' });
    assert.equal(last.embeds[0].description.match(/<@/g).length, 2);
    assert.match(last.embeds[0].description, /pts\*\*\n\u20031 game\n/);
    assert.doesNotMatch(last.embeds[0].description, /avg score/);
    assert.equal(buttons(last)[0].disabled, false);
    assert.equal(buttons(last)[1].disabled, true);
  } finally { store.close(); }
});

test('Next, Previous, and game selection update the existing reply and preserve ownership', async () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const initial = buildLeaderboardView(store, 'server', { ownerId: '123' });
    const next = component(buttons(initial)[1].custom_id);
    await handleInteraction(next, store);
    assert.equal(next.acknowledged, true);
    assert.match(next.result.embeds[0].footer.text, /Page 2\/3/);
    const previous = component(buttons(next.result)[0].custom_id);
    await handleInteraction(previous, store);
    assert.match(previous.result.embeds[0].footer.text, /Page 1\/3/);
    const select = component(next.result.components[0].components[0].custom_id, ['krillion']);
    await handleInteraction(select, store);
    assert.equal(select.result.embeds[0].title, '🏆 Monthly · Krillion leaderboard');
    assert.match(select.result.embeds[0].footer.text, /Page 1\/3/);
    assert.match(select.result.embeds[0].description, /110 pts\*\*\n\u20031 game\n\u2003110 average pts/);
    assert.equal(select.result.components[0].components[0].options.find((option) => option.value === 'krillion').default, true);
    const overall = component(select.result.components[0].components[0].custom_id, ['~']);
    await handleInteraction(overall, store);
    assert.equal(overall.result.embeds[0].title, '🏆 Monthly · Overall leaderboard');
    assert.equal(overall.denied, undefined);
  } finally { store.close(); }
});

test('Refresh loads live scores, recovers a disappearing page, and falls back from disabled games', async () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    const initial = buildLeaderboardView(store, 'server', { ownerId: '123', page: 3, gameKey: 'krillion' });
    store.removeMessage('server', '100');
    store.removeMessage('server', '101');
    const refresh = component(buttons(initial)[2].custom_id);
    await handleInteraction(refresh, store);
    assert.match(refresh.result.embeds[0].footer.text, /Page 2\/2 · 10 players/);
    store.setEnabled('server', 'krillion', false);
    const disabled = component(buttons(refresh.result)[2].custom_id);
    await handleInteraction(disabled, store);
    assert.equal(disabled.result.embeds[0].title, '🏆 Monthly · Overall leaderboard');
    assert.match(disabled.result.embeds[0].description, /No scores recorded/);
    assert.equal(buttons(disabled.result)[1].disabled, true);
    assert.equal(disabled.result.components[0].components[0].options.some((option) => option.value === 'krillion'), false);
  } finally { store.close(); }
});

test('controls reject another user and invalid state without changing the card', async () => {
  const store = new Store(':memory:');
  try {
    seed(store, 1);
    const other = component('lb:1:refresh:999:~:1');
    await handleInteraction(other, store);
    assert.match(other.denied.content, /your own/);
    assert.equal(other.denied.flags, MessageFlags.Ephemeral);
    assert.equal(other.acknowledged, undefined);
    const invalid = component('lb:1:refresh:123:~:not-a-page');
    await handleInteraction(invalid, store);
    assert.match(invalid.denied.content, /unavailable/);
    const badSelection = component('lb:1:select0:123:~:1', ['../../not-a-game']);
    await handleInteraction(badSelection, store);
    assert.match(badSelection.denied.content, /Choose a game/);
    assert.equal(badSelection.result, undefined);
  } finally { store.close(); }
});

test('all 25 games fit in menus without exceeding Discord limits, including selection of the last game', async () => {
  const store = new Store(':memory:');
  try {
    seed(store, 1);
    for (let index = 0; index < 21; index++) store.addGame('server', {
      key: `game-${index}`, name: `Game ${index}`, template: `Game ${index} #{puzzle} {score}`, direction: 'higher',
    });
    const games = store.games('server', true);
    const lastKey = games.at(-1).key;
    const view = buildLeaderboardView(store, 'server', { ownerId: '123', gameKey: lastKey });
    assert.equal(view.components.length, 4);
    const ids = new Set();
    const options = [];
    for (const row of view.components) for (const item of row.components) {
      assert.ok(item.custom_id.length <= 100);
      assert.equal(ids.has(item.custom_id), false);
      ids.add(item.custom_id);
      if (item.options) { assert.ok(item.options.length <= 25); options.push(...item.options); }
    }
    for (const game of games) assert.ok(options.some((option) => option.value === game.key));
    assert.equal(options.find((option) => option.value === lastKey).default, true);
    const lastMenu = view.components[1].components[0];
    const select = component(lastMenu.custom_id, [lastKey]);
    await handleInteraction(select, store);
    assert.match(select.result.embeds[0].title, new RegExp(games.at(-1).name));
  } finally { store.close(); }
});

test('slash command returns a private embed, handles empty servers, and rejects invalid requested pages', async () => {
  const store = new Store(':memory:');
  try {
    const interaction = {
      guildId: 'server', commandName: 'leaderboard', user: { id: '123' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      options: { getString: () => null, getInteger: () => 1 },
      deferReply: async function (value) { this.flags = value.flags; },
      editReply: async function (value) { this.result = value; },
    };
    await handleInteraction(interaction, store);
    assert.equal(interaction.flags, MessageFlags.Ephemeral);
    assert.match(interaction.result.embeds[0].description, /No scores/);
    assert.equal(buttons(interaction.result)[0].disabled, true);
    assert.equal(buttons(interaction.result)[1].disabled, true);
    assert.throws(() => buildLeaderboardView(store, 'server', { ownerId: '123', page: 2 }), /between 1 and 1/);
    assert.throws(() => buildLeaderboardView(store, 'server', { ownerId: '123', gameKey: 'missing' }), /Unknown or disabled/);
  } finally { store.close(); }
});
