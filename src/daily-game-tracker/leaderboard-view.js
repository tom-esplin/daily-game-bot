import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
} from 'discord.js';
import { leaderboard } from './rankings.js';
import { leaderboardPeriodLabel, submissionsForPeriod } from './leaderboard-period.js';
import { formatPlayerScore } from './score-view.js';

const PAGE_SIZE = 5;
const OVERALL = '~';
const stateId = (action, ownerId, gameKey, page, period) => `lb:2:${action}:${ownerId}:${gameKey || OVERALL}:${page}:${period}`;

export function buildLeaderboardView(store, guildId, {
  ownerId, gameKey = null, page = 1, recover = false, now = new Date(), period = 'monthly',
}) {
  const periodLabel = leaderboardPeriodLabel(period, now);
  const games = store.games(guildId, true);
  let game = gameKey ? games.find((entry) => entry.key === gameKey) : null;
  if (gameKey && !game) {
    if (!recover) throw new Error('Unknown or disabled game. Use /game list to see available games.');
    gameKey = null;
    page = 1;
  }
  const rows = leaderboard(submissionsForPeriod(store.submissions(guildId), period, now), games, gameKey, {
    sortBy: period === 'alltime' ? 'average' : 'total',
  });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) {
    if (!recover) throw new Error(`Choose a page between 1 and ${pages}.`);
    page = Math.max(1, Math.min(Number.isSafeInteger(page) ? page : 1, pages));
  }
  const lines = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((player) => {
    const rank = rows.findIndex((row) => Math.abs(row.rankingScore - player.rankingScore) < 1e-9) + 1;
    const place = ['🥇', '🥈', '🥉'][rank - 1] || `**${rank}.**`;
    const stats = gameKey ? player.games.get(gameKey) : null;
    const count = stats ? stats.count : player.count;
    return `${place} ${formatPlayerScore(player.userId, player.points, count, store)}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🏆 ${period === 'monthly' ? 'Monthly' : 'All Time'} · ${game ? game.name : 'Overall'} leaderboard`)
    .setDescription(lines.join('\n\n') || 'No scores recorded for this period. Share a result in a tracked channel or use /backfill.')
    .setFooter({ text: `${periodLabel} · Page ${page}/${pages} · ${rows.length} players · Updated` })
    .setTimestamp(now);

  // Include Overall in every menu, with at most 24 games per menu (Discord allows 25 options).
  const components = [];
  for (let start = 0; start < Math.max(1, games.length); start += 24) {
    const options = [{ label: 'Overall', value: OVERALL, default: !gameKey && start === 0 },
      ...games.slice(start, start + 24).map((entry) => ({
        label: entry.name, value: entry.key, default: entry.key === gameKey,
      }))];
    const select = new StringSelectMenuBuilder()
      .setCustomId(stateId(`select${components.length}`, ownerId, gameKey, page, period))
      .setPlaceholder(start ? 'More games' : 'Choose a leaderboard')
      .addOptions(options);
    components.push(new ActionRowBuilder().addComponents(select));
  }
  components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(stateId('period', ownerId, gameKey, page, period))
    .setPlaceholder('Choose a time period')
    .addOptions(
      { label: 'Monthly', description: 'Total scores for the current calendar month', value: 'monthly', default: period === 'monthly' },
      { label: 'All Time', description: 'Total scores across all recorded months', value: 'alltime', default: period === 'alltime' },
    )));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(stateId('previous', ownerId, gameKey, page, period))
      .setLabel('Previous').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
    new ButtonBuilder().setCustomId(stateId('next', ownerId, gameKey, page, period))
      .setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page === pages),
    new ButtonBuilder().setCustomId(stateId('refresh', ownerId, gameKey, page, period))
      .setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  ));
  return { content: null, embeds: [embed.toJSON()], components: components.map((row) => row.toJSON()), allowedMentions: { parse: [] } };
}

export async function handleLeaderboardComponent(interaction, store) {
  const parts = interaction.customId.split(':');
  const [prefix, version, action, ownerId, key, rawPage, savedPeriod] = parts;
  const period = version === '1' ? 'monthly' : savedPeriod;
  const page = Number(rawPage);
  const gameSelect = /^select\d+$/.test(action || '');
  const periodSelect = action === 'period';
  const select = gameSelect || periodSelect;
  const isSelect = interaction.isStringSelectMenu?.();
  const valid = ((parts.length === 6 && version === '1') || (parts.length === 7 && version === '2'))
    && prefix === 'lb' && ['monthly', 'alltime'].includes(period) && ownerId && key
    && (key === OVERALL || /^[a-z0-9-]{1,32}$/.test(key))
    && /^\d+$/.test(rawPage) && Number.isSafeInteger(page) && page > 0
    && (select ? isSelect : interaction.isButton?.() && ['previous', 'next', 'refresh'].includes(action));
  if (!valid || !interaction.guildId || ownerId !== interaction.user.id) {
    await interaction.reply({
      content: ownerId !== interaction.user.id ? 'Run /leaderboard to open your own leaderboard controls.' : 'These controls are unavailable. Run /leaderboard again.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
    return;
  }
  if (select && (interaction.values?.length !== 1 ||
    !(periodSelect ? ['monthly', 'alltime'].includes(interaction.values[0])
      : interaction.values[0] === OVERALL || /^[a-z0-9-]{1,32}$/.test(interaction.values[0])))) {
    await interaction.reply({ content: 'Choose a game or time period from the menu, or run /leaderboard again.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  try {
    const selected = gameSelect ? interaction.values[0] : key;
    const nextPage = select ? 1 : page + (action === 'next' ? 1 : action === 'previous' ? -1 : 0);
    await interaction.editReply(buildLeaderboardView(store, interaction.guildId, {
      ownerId, gameKey: selected === OVERALL ? null : selected, page: nextPage, recover: true,
      period: periodSelect ? interaction.values[0] : period,
    }));
  } catch (error) {
    console.error('Leaderboard refresh failed:', error.message);
    await interaction.followUp({ content: 'Could not refresh the leaderboard. Please try again.', flags: MessageFlags.Ephemeral });
  }
}
