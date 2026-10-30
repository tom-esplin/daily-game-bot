import { EmbedBuilder } from 'discord.js';
import { leaderboard } from './rankings.js';
import { leaderboardPeriodLabel, submissionsForPeriod } from './leaderboard-period.js';
import { playerLabel } from '../daily-player/player-identity.js';

const number = (value) => Number(value.toFixed(2)).toString();

export function formatPlayerScore(userId, points, count, store) {
  const average = count ? points / count : 0;
  return `${playerLabel(store, userId)}\n\u2003**${number(points)} pts**\n\u2003${count} ${count === 1 ? 'game' : 'games'}\n\u2003${number(average)} average pts`;
}

export function buildUserScoreView(store, guildId, {
  userId, gameKey = null, period = 'monthly', now = new Date(),
}) {
  const periodLabel = leaderboardPeriodLabel(period, now);
  const game = gameKey ? store.game(guildId, gameKey) : null;
  if (gameKey && !game) throw new Error('Unknown game. Use /game list to see game keys.');
  if (game && !game.enabled) throw new Error('Enable this game to query its stored scores.');
  const rows = leaderboard(submissionsForPeriod(store.submissions(guildId), period, now), store.games(guildId, true), gameKey);
  const player = rows.find((row) => row.userId === userId);
  const count = player ? (gameKey ? player.games.get(gameKey).count : player.count) : 0;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📊 ${period === 'monthly' ? 'Monthly' : 'All Time'} · ${game ? game.name : 'Overall'} score`)
    .setDescription(formatPlayerScore(userId, player?.points ?? 0, count, store))
    .setFooter({ text: `${periodLabel}${count ? '' : ' · No results recorded for this period'} · Updated` })
    .setTimestamp(now);
  return { content: null, embeds: [embed.toJSON()], allowedMentions: { parse: [] } };
}
