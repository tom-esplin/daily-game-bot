import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { importChannelHistory, MAX_BACKFILL_LIMIT } from '../src/backfill.js';
import { handleInteraction } from '../src/handlers.js';
import { commands } from '../src/commands.js';

function history(count) {
  const messages = Array.from({ length: count }, (_, index) => ({ id: String(20000 - index), index }));
  const cursors = new Map(messages.map((message, index) => [message.id, index]));
  const requests = [];
  return {
    requests,
    isTextBased: () => true,
    messages: { fetch: async (options) => {
      requests.push(options);
      assert.ok(options.limit > 0 && options.limit <= 100);
      const start = options.before ? cursors.get(options.before) + 1 : 0;
      return new Collection(messages.slice(start, start + options.limit).map((message) => [message.id, message]));
    } },
  };
}

test('10,000-message imports page backward without repeats and report progress', async () => {
  const channel = history(10005);
  const seen = new Set();
  const progress = [];
  const result = await importChannelHistory(channel, {
    ingest: (message) => {
      assert.equal(seen.has(message.id), false);
      seen.add(message.id);
      return message.index % 20 === 0 ? 1 : 0;
    },
  }, { limit: 10000, onProgress: async (value) => progress.push(value) });
  assert.deepEqual(result, { scanned: 10000, matched: 500 });
  assert.equal(channel.requests.length, 100);
  assert.equal(channel.requests[1].before, '19901');
  assert.equal(seen.size, 10000);
  assert.equal(progress.length, 9);
  assert.deepEqual(progress[0], { scanned: 1000, matched: 50, limit: 10000 });
  assert.equal(progress.at(-1).scanned, 9000);
});

test('backfill stops at the end of history and respects a partial final batch', async () => {
  const short = history(250);
  assert.deepEqual(await importChannelHistory(short, { ingest: () => 1 }, { limit: 10000 }), { scanned: 250, matched: 250 });
  const partial = history(250);
  assert.deepEqual(await importChannelHistory(partial, { ingest: () => 0 }, { limit: 125 }), { scanned: 125, matched: 0 });
  assert.deepEqual(partial.requests.map((request) => request.limit), [100, 25]);
  const defaults = history(250);
  assert.equal((await importChannelHistory(defaults, { ingest: () => 0 })).scanned, 100);
});

test('invalid backfill limits are rejected before fetching, and Discord exposes the new cap', async () => {
  const channel = history(0);
  for (const limit of [0, -1, 10001, 1.5, NaN]) {
    await assert.rejects(importChannelHistory(channel, { ingest: () => 0 }, { limit }), /between 1 and 10,000/);
  }
  assert.equal(channel.requests.length, 0);
  const option = commands.find((command) => command.name === 'backfill').options[0];
  assert.equal(option.max_value, MAX_BACKFILL_LIMIT);
});

test('backfill command sends progress and completion in the same private reply', async () => {
  const channel = history(1100);
  const replies = [];
  const interaction = {
    guildId: 'backfill-test', commandName: 'backfill',
    isAutocomplete: () => false, isChatInputCommand: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    deferReply: async () => {}, editReply: async (value) => replies.push(value),
    options: { getInteger: () => 1100, getChannel: () => null },
    guild: { channels: { fetch: async () => channel } },
  };
  await handleInteraction(interaction, { channels: () => ['channel'], ingest: () => 1 });
  assert.equal(replies.length, 2);
  assert.match(replies[0].content, /scanned 1,000 of up to 1,100/);
  assert.match(replies[1].content, /Scanned 1100 messages and processed 1100/);
});

test('an interrupted fetch releases the server import lock for another attempt', async () => {
  const channel = history(1);
  const normalFetch = channel.messages.fetch;
  channel.messages.fetch = async () => { throw new Error('Connection interrupted'); };
  const interaction = {
    guildId: 'backfill-retry-test', commandName: 'backfill',
    isAutocomplete: () => false, isChatInputCommand: () => true,
    memberPermissions: { has: () => true }, deferReply: async () => {}, editReply: async () => {},
    options: { getInteger: () => 10000, getChannel: () => null }, guild: { channels: { fetch: async () => channel } },
  };
  const store = { channels: () => ['channel'], ingest: () => 1 };
  let reply;
  interaction.editReply = async (value) => { reply = value; };
  await handleInteraction(interaction, store);
  assert.match(reply.content, /Could not finish 1 channels/);
  channel.messages.fetch = normalFetch;
  await assert.doesNotReject(handleInteraction(interaction, store));
});
