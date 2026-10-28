import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { LEADERBOARD_TIME_ZONE } from './leaderboard-period.js';
import { CODENAMES_GAME } from './codenames.js';
import { MUSIC_TIMELINER_GAME } from './musictimeliner.js';

const fallbackGames = [
  { key: 'krillion', name: 'Krillion', direction: 'higher' },
  { key: 'maptapp', name: 'Maptap', direction: 'higher' },
  CODENAMES_GAME, MUSIC_TIMELINER_GAME,
];
const customId = (action, ownerId, page) => `dailyhelp:1:${action}:${ownerId}:${page}`;

function explainGame(game) {
  let text;
  if (game.parser === 'codenames') {
    text = 'Rounds 1–3 each earn up to **30 pts**: 30 × correct words ÷ target words in that round. Round 4 adds up to **10 pts** the same way. Add all four rounds, then round down. Maximum: **100 pts**. ';
  } else if (game.parser === 'musictimeliner') {
    text = 'Each 🟩 earns **12.5 pts**; 🟥 earns 0. Round down the final total. Eight greens earn **100 pts**; three greens earn **37 pts**.';
  } else if (game.key === 'krillion') {
    text = 'Seven daily trivia rounds reward rare valid answers with more points, up to 100 per round and **700 pts** total.';
  } else if (['maptapp', 'maptap'].includes(game.key)) {
    text = 'Five geography rounds score up to 100 each, weighted **×1, ×1, ×2, ×3, ×3**, for **1,000 pts** maximum.';
  } else {
    text = `Each daily puzzle counts as one game played. ${game.direction === 'lower' ? 'Lower' : 'Higher'} scores are better.`;
  }
  return text;
}

function helpPages(store, guildId) {
  const configured = store.games(guildId);
  const games = configured.length ? configured : fallbackGames;
  const pages = [new EmbedBuilder().setTitle('📖 Daily games guide').setDescription(
    'Welcome to the daily games competition, gamers. To get started simply start pasting daily game output into the daily-games or codenames-daily channel. The bot will automatically start tracking your score. Currently, it supports Krillion, Codenames Daily, Music Timeliner, and Maptapp.',
  ).addFields(
    { name: 'How results become leaderboard points', value: 'A per-game leaderboard adds that game’s **native scores**. The overall converts **each result** to 0–100 first, then adds them: 350 Krillion pts → 50 overall pts; 434 Maptap pts → 43.4 overall pts with the standard ranges. Playing more daily puzzles adds more points.' },
  )];
  for (let start = 0; start < games.length; start += 6) {
    pages.push(new EmbedBuilder().setTitle('🎮 How each game is scored').addFields(
      games.slice(start, start + 6).map((game) => ({
        name: `${game.name.replace(/[\r\n]/g, ' ')}${game.enabled === 0 ? ' (disabled)' : ''}`,
        value: explainGame(game),
      })),
    ));
  }
  pages.push(new EmbedBuilder().setTitle('💬 Commands for players').addFields(
    { name: '/leaderboard [game] [period]', value: '`/leaderboard` — current-month overall totals.\n`/leaderboard period:alltime` — all-time overall totals.\n`/leaderboard game:maptapp period:monthly` — one game.\nThe game and period menus switch views; Previous/Next show **5 players per page**; Refresh reloads scores. Changing a filter resets to page 1.' },
    { name: '/score [user] [game] [period]', value: '`/score` — your monthly overall total, game count, and average.\n`/score period:alltime` — your all-time score.\n`/score user:@Alice` — another player’s monthly score; select the actual user in Discord.\n`/score user:@Alice game:krillion period:alltime` — another player’s total for one game.\nWithout a game filter, Overall uses converted points. Users without results show 0 pts and 0 games.' },
    { name: '/game list', value: 'Show this server’s game names, **keys**, enabled/disabled status, templates, score directions, and active conversion ranges. Use a key such as `maptapp` in a command’s `game` option.' },
    { name: '/explain-dailys', value: 'Open this guide. Use Previous/Next to browse. This guide and the commands above do not require Manage Server; your server can still restrict command access.' },
  ));
  return pages;
}

export function buildExplainView(store, guildId, { ownerId, page = 1, recover = false }) {
  const pages = helpPages(store, guildId);
  if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) {
    if (!recover) throw new Error(`Choose a guide page between 1 and ${pages.length}.`);
    page = Math.max(1, Math.min(Number.isSafeInteger(page) ? page : 1, pages.length));
  }
  const embed = pages[page - 1].setColor(0x5865F2).setFooter({ text: `Page ${page}/${pages.length} · /explain-dailys` });
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('previous', ownerId, page)).setLabel('Previous')
      .setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
    new ButtonBuilder().setCustomId(customId('next', ownerId, page)).setLabel('Next')
      .setStyle(ButtonStyle.Secondary).setDisabled(page === pages.length),
  );
  return { content: null, embeds: [embed.toJSON()], components: [controls.toJSON()], allowedMentions: { parse: [] } };
}

export async function handleExplainComponent(interaction, store) {
  const parts = interaction.customId.split(':');
  const [prefix, version, action, ownerId, rawPage] = parts;
  const page = Number(rawPage);
  if (parts.length !== 5 || prefix !== 'dailyhelp' || version !== '1' || !['previous', 'next'].includes(action)
    || !/^\d+$/.test(rawPage) || !Number.isSafeInteger(page) || page < 1
    || !interaction.guildId || ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Run /explain-dailys to open your own guide.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  try {
    await interaction.editReply(buildExplainView(store, interaction.guildId, {
      ownerId, page: page + (action === 'next' ? 1 : -1), recover: true,
    }));
  } catch (error) {
    console.error('Could not update the daily games guide:', error.message);
    await interaction.followUp({ content: 'Could not update the guide. Please run /explain-dailys again.', flags: MessageFlags.Ephemeral });
  }
}
