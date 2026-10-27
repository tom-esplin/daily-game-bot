import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubmission, compileTemplate, normalizePuzzle } from '../src/parser.js';
import { Store } from '../src/store.js';
import { leaderboard } from '../src/rankings.js';

const share = (score = 340, puzzle = 100) => `Krillion #${puzzle} 🦐\n${score}\n\n🫧🐟🫧🦑🏮🏮🦑`;
const message = (overrides = {}) => ({
  guildId: 'server', channelId: 'channel', id: '100', content: share(),
  author: { id: 'alice', username: 'Alice', bot: false }, createdTimestamp: 1000, ...overrides,
});

test('parses the supplied Krillion share, CRLF, and an inline custom game', () => {
  assert.deepEqual(parseSubmission(share(), 'Krillion #{puzzle}\n{score}'), { puzzle: '100', score: 340 });
  assert.deepEqual(parseSubmission(share().replaceAll('\n', '\r\n'), 'Krillion #{puzzle}\\n{score}'), { puzzle: '100', score: 340 });
  assert.deepEqual(parseSubmission('Wordle 1200 4/6\n🟩🟩🟩', 'Wordle {puzzle} {score}/6'), { puzzle: '1200', score: 4 });
  assert.deepEqual(parseSubmission('Test #7\n-2.5', 'Test #{puzzle}\n{score}'), { puzzle: '7', score: -2.5 });
});

test('rejects unrelated messages, malformed numbers, failed games, and invalid templates', () => {
  for (const value of ['hello', 'Krillion #100\nno score', 'Krillion #100\n340,000', 'Krillion #100\n340.5.2']) {
    assert.equal(parseSubmission(value, 'Krillion #{puzzle}\n{score}'), null);
  }
  assert.equal(parseSubmission('Wordle 1200 X/6', 'Wordle {puzzle} {score}/6'), null);
  for (const template of ['{score}', '{puzzle}{score}{score}', '{puzzle}{score}{unknown}']) {
    assert.throws(() => compileTemplate(template));
  }
  assert.equal(parseSubmission('TestX #1 2', 'Test. #{puzzle} {score}'), null);
});

const maptapTemplate = 'www.maptap.gg {puzzle}\\n{skip}\\nFinal score: {score}';
const maptapShare = 'www.maptap.gg October 20\n98:fire: 75:upside_down: 99:fire: 80:clap: 83:star2:\nFinal score: 860';

test('Maptap captures the final score, skips result lines, and normalizes the puzzle date', () => {
  const timestamp = Date.UTC(2026, 9, 23);
  assert.deepEqual(parseSubmission(maptapShare, maptapTemplate, timestamp), { puzzle: '2026-10-20', score: 860 });
  assert.deepEqual(parseSubmission(maptapShare.replaceAll('\n', '\r\n'), maptapTemplate, timestamp), { puzzle: '2026-10-20', score: 860 });
  assert.deepEqual(parseSubmission('www.maptap.gg October 20\n\n98🔥 75🙃 99🔥 80👏 83🌟\n\nFinal score: 860', maptapTemplate, timestamp), { puzzle: '2026-10-20', score: 860 });
  assert.deepEqual(parseSubmission('www.maptap.gg October 20\nFinal score: 860', maptapTemplate, timestamp), { puzzle: '2026-10-20', score: 860 });
  assert.equal(parseSubmission(maptapShare.replace('Final score: 860', 'no final score'), maptapTemplate, timestamp), null);
  assert.equal(parseSubmission(maptapShare.replace('October 20', 'October 99'), maptapTemplate, timestamp), null);
  assert.equal(parseSubmission(maptapShare, 'www.maptap.gg {puzzle}\\nFinal score: {score}', timestamp), null);
});

test('date puzzles validate dates and infer the closest year from the original message timestamp', () => {
  assert.equal(normalizePuzzle('December 31', Date.UTC(2027, 0, 1)), '2026-12-31');
  assert.equal(normalizePuzzle('January 1', Date.UTC(2026, 11, 31)), '2027-01-01');
  assert.equal(normalizePuzzle('October 20, 2025', Date.UTC(2026, 9, 23)), '2025-10-20');
  assert.equal(normalizePuzzle('2024-02-29'), '2024-02-29');
  assert.equal(normalizePuzzle('2026-02-29'), null);
  assert.equal(normalizePuzzle('February 30', Date.UTC(2026, 1, 1)), null);
  assert.equal(normalizePuzzle('April 31, 2026'), null);
  assert.equal(normalizePuzzle('00100'), '100');
  for (const template of [
    '{skip}\n{puzzle}\n{score}', '{puzzle}\n{score}\n{skip}',
    '{puzzle}\nignored {skip}\n{score}', '{puzzle}\n{skip}\n{skip}\n{score}',
  ]) assert.throws(() => compileTemplate(template));
});

test('Maptap imports use the posted year, deduplicate per date, and participate in standings', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    assert.equal(store.game('server', 'maptapp').direction, 'higher');
    store.ingest(message({ content: maptapShare, createdTimestamp: Date.UTC(2026, 9, 20) }));
    store.ingest(message({ id: '101', content: maptapShare.replace('860', '900'), createdTimestamp: Date.UTC(2026, 9, 21) }));
    store.ingest(message({ id: '102', content: maptapShare, createdTimestamp: Date.UTC(2025, 9, 20) }));
    store.ingest(message({ id: '103', content: maptapShare, createdTimestamp: Date.UTC(2026, 9, 20), author: { id: 'bob', username: 'Bob', bot: false } }));
    const rows = store.submissions('server');
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.user_id === 'alice' && row.puzzle === '2026-10-20').score, 900);
    assert.equal(rows.find((row) => row.puzzle === '2025-10-20').score, 860);
    const rankings = leaderboard(rows, store.games('server', true), 'maptapp');
    assert.equal(rankings[0].userId, 'alice');
    assert.equal(rankings[0].points, 1760);
    assert.equal(rankings[1].points, 860);
  } finally { store.close(); }
});

test('built-in Maptap records the October 26 final score and preserves its disabled setting', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    const content = 'www.maptap.gg October 26\n\n94 97 60 32 9\n\nFinal score: 434';
    assert.equal(store.ingest(message({ content, createdTimestamp: Date.UTC(2026, 9, 26) })), 1);
    const row = store.submissions('server')[0];
    assert.equal(row.game_key, 'maptapp');
    assert.equal(row.puzzle, '2026-10-26');
    assert.equal(row.score, 434);
    store.setEnabled('server', 'maptapp', false);
    store.track('server', 'channel');
    assert.equal(store.game('server', 'maptapp').enabled, 0);
  } finally { store.close(); }
});

test('SQLite persists scores, isolates servers, and handles repeat posts, edits, and deletions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-games-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    store.track('server', 'channel');
    assert.equal(store.ingest(message({ channelId: 'elsewhere' })), 0);
    assert.equal(store.ingest(message({ author: { id: 'bot', username: 'Bot', bot: true } })), 0);
    store.ingest(message());
    store.ingest(message());
    assert.equal(store.submissions('server').length, 1);
    store.ingest(message({ content: share(450) }));
    assert.equal(store.submissions('server')[0].score, 450);
    store.ingest(message({ id: '101', createdTimestamp: 2000, content: share(500) }));
    store.ingest(message({ content: share(460) })); // Editing an earlier post does not override a newer one.
    assert.equal(store.submissions('server')[0].score, 500);
    store.removeMessage('server', '101');
    assert.equal(store.submissions('server')[0].score, 460);
    store.close();
    store = new Store(path);
    assert.equal(store.submissions('server')[0].score, 460);
    store.track('other', 'channel');
    assert.equal(store.submissions('other').length, 0);
    store.ingest(message({ content: 'edited into unrelated text' }));
    assert.equal(store.submissions('server').length, 0);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('disabled games retain their records during reimport and can be enabled again', () => {
  const store = new Store(':memory:');
  try {
    store.track('server', 'channel');
    store.ingest(message());
    store.setEnabled('server', 'krillion', false);
    store.ingest(message());
    assert.equal(store.submissions('server').length, 0);
    store.setEnabled('server', 'krillion', true);
    assert.equal(store.submissions('server').length, 1);
    store.addGame('server', { key: 'wordle', name: 'Wordle', template: 'Wordle {puzzle} {score}/6', direction: 'lower' });
    store.ingest(message({ id: '102', content: 'Wordle 1200 3/6' }));
    assert.equal(store.submissions('server').length, 2);
    assert.throws(() => store.addGame('server', { key: 'wordle', name: 'Again', template: '{puzzle}{score}', direction: 'lower' }));
  } finally { store.close(); }
});

test('each recorded result adds its converted score regardless of native score scale', () => {
  const games = [{ key: 'large', direction: 'higher', score_min: 0, score_max: 100000 },
    { key: 'small', direction: 'lower', score_min: 2, score_max: 6 }];
  const rows = [];
  for (let puzzle = 1; puzzle <= 10; puzzle++) {
    rows.push({ game_key: 'large', puzzle: String(puzzle), user_id: 'alice', score: 100000 });
    rows.push({ game_key: 'large', puzzle: String(puzzle), user_id: 'bob', score: 0 });
  }
  rows.push({ game_key: 'small', puzzle: '1', user_id: 'alice', score: 6 });
  rows.push({ game_key: 'small', puzzle: '1', user_id: 'bob', score: 2 });
  const result = leaderboard(rows, games);
  assert.equal(result[0].points, 1000);
  assert.equal(result[1].points, 100);
  assert.equal(leaderboard(rows, games, 'small')[0].userId, 'bob');
});

test('ties retain equal scores, solo results use the actual score, and missing games are excluded', () => {
  const games = [{ key: 'a', direction: 'higher' }, { key: 'b', direction: 'higher' }];
  const rows = [
    { game_key: 'a', puzzle: '1', user_id: 'alice', score: 10 },
    { game_key: 'a', puzzle: '1', user_id: 'bob', score: 10 },
    { game_key: 'a', puzzle: '1', user_id: 'carol', score: 1 },
    { game_key: 'b', puzzle: '1', user_id: 'solo', score: 60 },
  ];
  const result = leaderboard(rows, games);
  assert.deepEqual(result.map((player) => player.points), [60, 10, 10, 1]);
  assert.equal(result.find((player) => player.userId === 'solo').games.size, 1);
});
