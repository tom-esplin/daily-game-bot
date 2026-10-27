import { GAME_SCORE_RANGES } from './scoring-config.js';

export function scoreRange(game) {
  const defaults = GAME_SCORE_RANGES[game.key] || [0, 100];
  return { min: game.score_min ?? defaults[0], max: game.score_max ?? defaults[1] };
}

export function normalizeScore(score, game) {
  const { min, max } = scoreRange(game);
  if (!Number.isFinite(score) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    throw new Error(`Invalid scoring range for ${game.key}. Check src/scoring-config.js.`);
  }
  const fraction = game.direction === 'lower' ? (max - score) / (max - min) : (score - min) / (max - min);
  return Math.max(0, Math.min(100, fraction * 100));
}

export function rankSubmissions(submissions, games) {
  const definitions = new Map(games.map((game) => [game.key, game]));
  const players = new Map();
  for (const row of submissions) {
    const definition = definitions.get(row.game_key);
    if (!definition) continue;
    if (!players.has(row.user_id)) players.set(row.user_id, { userId: row.user_id, games: new Map() });
    const player = players.get(row.user_id);
    if (!player.games.has(row.game_key)) player.games.set(row.game_key, { points: 0, score: 0, count: 0 });
    const game = player.games.get(row.game_key);
    game.points += normalizeScore(row.score, definition);
    game.score += row.score;
    game.count++;
  }
  return [...players.values()].map((player) => {
    player.points = [...player.games.values()].reduce((sum, game) => sum + game.points, 0);
    player.count = [...player.games.values()].reduce((sum, game) => sum + game.count, 0);
    return player;
  });
}

export function leaderboard(submissions, games, gameKey = null) {
  const lower = gameKey && games.find((game) => game.key === gameKey)?.direction === 'lower';
  return rankSubmissions(submissions, games)
    .filter((player) => !gameKey || player.games.has(gameKey))
    .map((player) => ({ ...player, points: gameKey ? player.games.get(gameKey).score : player.points }))
    .sort((a, b) => (lower ? a.points - b.points : b.points - a.points) || a.userId.localeCompare(b.userId));
}
