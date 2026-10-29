import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { Store } from '../src/store.js';
import { commands } from '../src/commands.js';
import { handleInteraction } from '../src/handlers.js';
import { buildExplainView } from '../src/explain-view.js';

const text = (view) => JSON.stringify(view.embeds);

test('guide covers leaderboard totals, all built-in games, and every non-admin command', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    const overview = buildExplainView(store, 'server', { ownerId: 'alice' });
    assert.match(text(overview), /Monthly and All Time/);
    assert.match(text(overview), /Monthly.*leaderboards rank by total points earned this month/);
    assert.match(text(overview), /All Time.*leaderboards rank by.*average pts/);
    assert.match(text(overview), /average pts/);
    assert.match(text(overview), /total points ÷ games played/);
    const scoring = text(buildExplainView(store, 'server', { ownerId: 'alice', page: 2 }));
    for (const name of ['Krillion', 'Maptap', 'Codenames Daily', 'Music Timeliner']) assert.ok(scoring.includes(name));
    assert.match(scoring, /30 pts/);
    assert.match(scoring, /10 pts/);
    assert.match(scoring, /12\.5 pts/);
    assert.doesNotMatch(scoring, /Game key:|Overall conversion:|bot records|recognized|configured template/);
    const usage = text(buildExplainView(store, 'server', { ownerId: 'alice', page: 3 }));
    for (const command of ['/leaderboard', '/score', '/game list', '/explain-dailys']) assert.ok(usage.includes(command));
    for (const command of ['/track', '/untrack', '/channels', '/backfill', '/game add']) assert.equal(usage.includes(command), false);
    assert.match(usage, /period:alltime/);
  } finally { store.close(); }
});

test('game scoring pages explain custom games and disabled status without key or conversion sections', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    store.addGame('server', { key: 'custom', name: 'Custom Daily', template: 'Custom #{puzzle}\n{score}', direction: 'lower' });
    store.setEnabled('server', 'custom', false);
    const view = buildExplainView(store, 'server', { ownerId: 'alice', page: 2 });
    assert.match(text(view), /Custom Daily \(disabled\)/);
    assert.match(text(view), /Lower scores are better/);
    assert.doesNotMatch(text(view), /Game key:|Overall conversion:|native range/);
  } finally { store.close(); }
});

test('a 25-game guide paginates and stays inside Discord embed and component limits', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    for (let index = 0; index < 21; index++) store.addGame('server', {
      key: `game-${index}`, name: `Game ${index}`, template: `Game ${index} #{puzzle} {score}`, direction: 'higher',
    });
    const seenGames = new Set();
    for (let page = 1; page <= 7; page++) {
      const view = buildExplainView(store, 'server', { ownerId: '123456789012345678', page });
      const embed = view.embeds[0];
      assert.match(embed.footer.text, new RegExp(`Page ${page}/7`));
      assert.ok((embed.description?.length || 0) <= 4096);
      assert.ok(embed.fields.length <= 25);
      let length = embed.title.length + (embed.description?.length || 0) + embed.footer.text.length;
      for (const field of embed.fields) {
        assert.ok(field.name.length <= 256);
        assert.ok(field.value.length <= 1024);
        length += field.name.length + field.value.length;
        if (page > 1 && page < 7) seenGames.add(field.name);
      }
      assert.ok(length <= 6000);
      for (const button of view.components[0].components) assert.ok(button.custom_id.length <= 100);
      assert.equal(view.components[0].components[0].disabled, page === 1);
      assert.equal(view.components[0].components[1].disabled, page === 7);
    }
    assert.equal(seenGames.size, 25);
    for (const game of store.games('server')) assert.ok(seenGames.has(game.name));
    assert.throws(() => buildExplainView(store, 'server', { ownerId: 'alice', page: 8 }), /between 1 and 7/);
  } finally { store.close(); }
});

test('non-admins can open the private guide before channel setup', async () => {
  const store = new Store(':memory:');
  try {
    const definition = commands.find((command) => command.name === 'explain-dailys');
    assert.ok(definition);
    assert.equal(definition.default_member_permissions, undefined);
    assert.equal((definition.options || []).length, 0);
    const interaction = {
      guildId: 'server', commandName: 'explain-dailys', user: { id: 'alice' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      memberPermissions: { has: () => false }, options: {},
      deferReply: async (value) => assert.equal(value.flags, MessageFlags.Ephemeral),
      editReply: async function (value) { this.view = value; },
    };
    await handleInteraction(interaction, store);
    assert.match(interaction.view.embeds[0].title, /Daily games guide/);
    assert.match(interaction.view.embeds[0].footer.text, /Page 1\/3/);
    assert.deepEqual(interaction.view.allowedMentions, { parse: [] });
  } finally { store.close(); }
});

test('guide buttons navigate pages and cannot be used by a different user', async () => {
  const store = new Store(':memory:');
  try {
    let view = buildExplainView(store, 'server', { ownerId: 'alice' });
    const interaction = {
      guildId: 'server', user: { id: 'alice' }, isButton: () => true,
      customId: view.components[0].components[1].custom_id,
      deferUpdate: async function () { this.acknowledged = true; },
      editReply: async (value) => { view = value; },
      reply: async function (value) { this.denied = value; }, followUp: async () => {},
    };
    await handleInteraction(interaction, store);
    assert.equal(interaction.acknowledged, true);
    assert.match(view.embeds[0].footer.text, /Page 2\/3/);
    interaction.customId = view.components[0].components[0].custom_id;
    await handleInteraction(interaction, store);
    assert.match(view.embeds[0].footer.text, /Page 1\/3/);
    interaction.user.id = 'bob';
    await handleInteraction(interaction, store);
    assert.match(interaction.denied.content, /your own guide/);
    assert.equal(interaction.denied.flags, MessageFlags.Ephemeral);
  } finally { store.close(); }
});
