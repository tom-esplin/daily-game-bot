import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/daily-game-tracker/store.js';
import { buildUserScoreView } from '../../src/daily-game-tracker/score-view.js';
import { buildLeaderboardView } from '../../src/daily-game-tracker/leaderboard-view.js';
import { handleInteraction } from '../../src/daily-game-tracker/handlers.js';

const now = new Date('2026-10-27T12:00:00Z');
const post = (overrides = {}) => ({ guildId: 'server', channelId: 'a', id: '100',
  content: 'Krillion #1\n350', createdTimestamp: Date.parse('2026-10-10T12:00:00Z'),
  author: { id: 'alice', username: 'Alice', bot: false }, ...overrides });

test('user scores agree with monthly and all-time leaderboard totals across tracked channels', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'a');
    store.track('server', 'b');
    store.ingest(post());
    store.ingest(post({ id: '101', channelId: 'b', content: 'www.maptap.gg October 11\nFinal score: 500' }));
    store.ingest(post({ id: '102', content: 'Krillion #2\n700', createdTimestamp: Date.parse('2026-09-10T12:00:00Z') }));
    const options = { userId: 'alice', now };
    const monthly = buildUserScoreView(store, 'server', options);
    assert.equal(monthly.embeds[0].description, '<@alice>\n\u2003**100 pts**\n\u20032 games\n\u200350 average pts');
    assert.ok(buildLeaderboardView(store, 'server', { ownerId: 'alice', now }).embeds[0].description.includes(monthly.embeds[0].description));
    const alltime = buildUserScoreView(store, 'server', { ...options, period: 'alltime' });
    assert.match(alltime.embeds[0].description, /200 pts\*\*\n\u20033 games\n\u200366.67 average pts/);
    const game = buildUserScoreView(store, 'server', { ...options, period: 'alltime', gameKey: 'krillion' });
    assert.match(game.embeds[0].description, /1050 pts\*\*\n\u20032 games\n\u2003525 average pts/);
    assert.match(monthly.embeds[0].footer.text, /October 2026/);
    assert.match(alltime.embeds[0].footer.text, /All Time/);
  } finally { store.close(); }
});

test('user summaries distinguish zero scores from missing results and respect server/game access', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'a');
    store.ingest(post({ content: 'Krillion #1\n0' }));
    const zero = buildUserScoreView(store, 'server', { userId: 'alice', now });
    assert.match(zero.embeds[0].description, /0 pts\*\*\n\u20031 game\n\u20030 average pts/);
    assert.doesNotMatch(zero.embeds[0].footer.text, /No results/);
    const missing = buildUserScoreView(store, 'server', { userId: 'bob', now });
    assert.match(missing.embeds[0].description, /0 pts\*\*\n\u20030 games\n\u20030 average pts/);
    assert.match(missing.embeds[0].footer.text, /No results/);
    assert.doesNotMatch(missing.embeds[0].description, /NaN/);
    const elsewhere = buildUserScoreView(store, 'other-server', { userId: 'alice', now });
    assert.match(elsewhere.embeds[0].description, /0 games/);
    assert.throws(() => buildUserScoreView(store, 'server', { userId: 'alice', now, gameKey: 'unknown' }), /Unknown game/);
    store.setEnabled('server', 'krillion', false);
    assert.throws(() => buildUserScoreView(store, 'server', { userId: 'alice', now, gameKey: 'krillion' }), /Enable this game/);
  } finally { store.close(); }
});

test('score command selects another user or defaults to the requester', async () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'a');
    store.ingest(post());
    store.ingest(post({ id: '101', content: 'Krillion #1\n700', author: { id: 'bob', username: 'Bob', bot: false } }));
    let reply;
    let selected = { id: 'bob' };
    const interaction = {
      guildId: 'server', commandName: 'score', user: { id: 'alice' },
      isAutocomplete: () => false, isChatInputCommand: () => true,
      options: { getString: (name) => name === 'period' ? 'alltime' : null, getUser: () => selected },
      deferReply: async () => {}, editReply: async (value) => { reply = value; },
    };
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].description, /<@bob>\n\u2003\*\*100 pts/);
    selected = null;
    await handleInteraction(interaction, store);
    assert.match(reply.embeds[0].description, /<@alice>\n\u2003\*\*50 pts/);
  } finally { store.close(); }
});
