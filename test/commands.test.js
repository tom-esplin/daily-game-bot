import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands.js';
import { handleInteraction } from '../src/handlers.js';
import { Store } from '../src/store.js';

test('score command defaults to monthly totals, supports all-time, and optionally filters by game', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    store.ingest({
      guildId: 'server', channelId: 'channel', id: '100',
      author: { id: 'alice', username: 'Alice', bot: false },
      content: 'www.maptap.gg October 20\n98🔥 75🙃 99🔥 80👏 83🌟\nFinal score: 860',
      createdTimestamp: Date.now(),
    });
    store.ingest({ guildId: 'server', channelId: 'channel', id: '101',
      author: { id: 'alice', username: 'Alice', bot: false },
      content: 'www.maptap.gg October 20\nFinal score: 1000', createdTimestamp: Date.UTC(2000, 9, 20) });
    let reply;
    let period = null;
    let game = 'maptapp';
    const interaction = {
      guildId: 'server', commandName: 'score', user: { id: 'alice' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      deferReply: async () => {}, editReply: async (value) => { reply = value; },
      options: { getString: (name) => name === 'game' ? game : period, getUser: () => null },
    };
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].title, /Monthly · Maptap score/);
    assert.match(reply.embeds[0].description, /860 pts\*\*\n\u20031 game/);
    period = 'alltime';
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].title, /All Time · Maptap score/);
    assert.match(reply.embeds[0].description, /1860 pts\*\*\n\u20032 games\n\u2003930 average pts/);
    game = null;
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].title, /All Time · Overall score/);
    assert.match(reply.embeds[0].description, /186 pts\*\*\n\u20032 games\n\u200393 average pts/);
  } finally { store.close(); }
});

test('Discord command builders expose user score periods and optional games instead of puzzle lookup', () => {
  const score = commands.find((command) => command.name === 'score');
  assert.equal(score.options.some((option) => option.name === 'puzzle'), false);
  assert.deepEqual(score.options.find((option) => option.name === 'period').choices.map((choice) => choice.value), ['monthly', 'alltime']);
  assert.notEqual(score.options.find((option) => option.name === 'game').required, true);
  const game = commands.find((command) => command.name === 'game');
  const add = game.options.find((option) => option.name === 'add');
  assert.match(add.options.find((option) => option.name === 'template').description, /\{skip\}/);
});
