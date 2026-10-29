import test from 'node:test';
import assert from 'node:assert/strict';
import { leaderboard } from '../src/rankings.js';
import { buildLeaderboardView } from '../src/leaderboard-view.js';
import { Store } from '../src/store.js';

test('all-time ranks by average while monthly ranks by total, preserving displayed totals', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    for (const [index, [userId, puzzle, score]] of [
      ['alice', 1, 350], ['alice', 2, 350], ['alice', 3, 350], ['bob', 1, 700],
    ].entries()) store.ingest({
      guildId: 'server', channelId: 'channel', id: String(100 + index),
      author: { id: userId, username: userId, bot: false }, createdTimestamp: Date.now(),
      content: `Krillion #${puzzle}\n${score}`,
    });
    for (const gameKey of [null, 'krillion']) {
      const monthly = buildLeaderboardView(store, 'server', { ownerId: 'alice', gameKey });
      assert.ok(monthly.embeds[0].description.startsWith('🥇 <@alice>'));
      const alltime = buildLeaderboardView(store, 'server', { ownerId: 'alice', gameKey, period: 'alltime' });
      assert.ok(alltime.embeds[0].description.startsWith('🥇 <@bob>'));
      assert.match(alltime.embeds[0].description, gameKey ? /1050 pts.*\n\u20033 games\n\u2003350 average pts/ : /150 pts.*\n\u20033 games\n\u200350 average pts/);
    }
  } finally { store.close(); }
});

test('equal averages share rank even with different total points and game counts', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    for (const [index, [userId, puzzle, score]] of [
      ['alice', 1, 350], ['alice', 2, 350], ['bob', 1, 350], ['carol', 1, 140],
    ].entries()) store.ingest({
      guildId: 'server', channelId: 'channel', id: String(100 + index),
      author: { id: userId, username: userId, bot: false }, createdTimestamp: Date.now(),
      content: `Krillion #${puzzle}\n${score}`,
    });
    const view = buildLeaderboardView(store, 'server', { ownerId: 'alice', period: 'alltime' });
    assert.match(view.embeds[0].description, /🥇 <@alice>/);
    assert.match(view.embeds[0].description, /🥇 <@bob>/);
    assert.match(view.embeds[0].description, /🥉 <@carol>/);
  } finally { store.close(); }
});

test('lower-is-better game averages rank ascending, and overall uses converted average points', () => {
  const games = [{ key: 'wordle', direction: 'lower', score_min: 1, score_max: 6 }];
  const rows = [
    { game_key: 'wordle', user_id: 'alice', score: 2 },
    { game_key: 'wordle', user_id: 'alice', score: 2 },
    { game_key: 'wordle', user_id: 'bob', score: 3 },
  ];
  assert.equal(leaderboard(rows, games, 'wordle')[0].userId, 'bob');
  assert.equal(leaderboard(rows, games, 'wordle', { sortBy: 'average' })[0].userId, 'alice');
  assert.equal(leaderboard(rows, games, null, { sortBy: 'average' })[0].userId, 'alice');
  assert.equal(leaderboard(rows, games, null, { sortBy: 'average' })[0].rankingScore, 80);
});
