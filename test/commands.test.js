import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands.js';
import { handleInteraction } from '../src/handlers.js';
import { Store } from '../src/store.js';

test('score command accepts dated puzzles and shows the stored final score', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    store.ingest({
      guildId: 'server', channelId: 'channel', id: '100',
      author: { id: 'alice', username: 'Alice', bot: false },
      content: 'www.maptap.gg October 20\n98🔥 75🙃 99🔥 80👏 83🌟\nFinal score: 860',
      createdTimestamp: Date.UTC(2026, 9, 20),
    });
    let reply;
    let puzzle = '2026-10-20';
    const interaction = {
      guildId: 'server', commandName: 'score', user: { id: 'alice' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      deferReply: async () => {}, editReply: async (value) => { reply = value; },
      options: { getString: (name) => name === 'game' ? 'maptapp' : puzzle, getUser: () => null },
    };
    await handleInteraction(interaction, store);
    assert.match(reply.content, /2026-10-20: \*\*860\*\*/);
    assert.doesNotMatch(reply.content, /#2026/);
    puzzle = 'October 20, 2026';
    await handleInteraction(interaction, store);
    assert.match(reply.content, /\*\*860\*\*/);
    puzzle = '2025-10-20';
    await handleInteraction(interaction, store);
    assert.match(reply.content, /No matching scores/);
    puzzle = '2026-02-30';
    await assert.rejects(handleInteraction(interaction, store), /valid date/);
  } finally { store.close(); }
});

test('Discord command builders serialize the updated template and date options', () => {
  const score = commands.find((command) => command.name === 'score');
  assert.match(score.options.find((option) => option.name === 'puzzle').description, /date/);
  const game = commands.find((command) => command.name === 'game');
  const add = game.options.find((option) => option.name === 'add');
  assert.match(add.options.find((option) => option.name === 'template').description, /\{skip\}/);
});
