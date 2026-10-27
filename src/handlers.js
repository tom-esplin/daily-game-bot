import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildLeaderboardView, handleLeaderboardComponent } from './leaderboard-view.js';
import { normalizePuzzle } from './parser.js';

const number = (value) => Number(value.toFixed(2)).toString();
const safeName = (value) => value.replace(/[`*_~|<>@\\]/g, '').replace(/[\r\n]/g, ' ');
const busyGuilds = new Set();

function requireAdmin(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need Manage Server permission to change tracking settings or import messages.');
  }
}

function requireGame(store, guildId, key) {
  const game = store.game(guildId, key);
  if (!game) throw new Error('Unknown game. Use /game list to see game keys.');
  return game;
}

export async function handleInteraction(interaction, store) {
  if ((interaction.isButton?.() || interaction.isStringSelectMenu?.()) && interaction.customId?.startsWith('lb:')) {
    await handleLeaderboardComponent(interaction, store);
    return;
  }
  if (interaction.isAutocomplete()) {
    const text = String(interaction.options.getFocused()).toLowerCase();
    const games = interaction.guildId ? store.games(interaction.guildId) : [];
    await interaction.respond(games.filter((game) => `${game.key} ${game.name}`.toLowerCase().includes(text))
      .slice(0, 25).map((game) => ({ name: `${game.name} (${game.key})`, value: game.key })));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) throw new Error('Use this command inside a server.');
  const guildId = interaction.guildId;
  let content;
  switch (interaction.commandName) {
    case 'track': {
      requireAdmin(interaction);
      if (busyGuilds.has(guildId)) throw new Error('Wait for the current import to finish before changing the channel.');
      const channel = interaction.options.getChannel('channel', true);
      const permissions = channel.permissionsFor(interaction.client.user);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new Error('Give the bot View Channel and Read Message History permissions in that channel.');
      }
      store.track(guildId, channel.id);
      content = `Tracking <#${channel.id}>. Krillion, Maptap, Codenames Daily, and Music Timeliner are included. Use /backfill to import older posts.`;
      break;
    }
    case 'game': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const games = store.games(guildId);
        content = games.length ? games.map((game) => {
          let description = `Template: ${safeName(game.template.replace(/\n/g, '\\n'))}`;
          if (game.parser === 'codenames') description = 'Scoring: rounds 1–3 each earn up to 30 points; round 4 adds up to 10 bonus points. Final total rounded down; maximum 100.';
          if (game.parser === 'musictimeliner') description = 'Scoring: 12.5 points per green square; 0 per red square; maximum 100. Final total rounded down. Unicode squares and :green_square:/:red_square: are supported.';
          return `**${safeName(game.name)}** — \`${game.key}\` (${game.enabled ? 'enabled' : 'disabled'}, ${game.direction} wins)\n${description}\nOverall scale: ${number(game.score_min)}–${number(game.score_max)} → 0–100.`;
        }).join('\n\n') : 'No games yet. Use /track to configure the channel and add the built-in games.';
        if (content.length > 1900) content = games.map((game) => `\`${game.key}\` — ${safeName(game.name)} (${game.enabled ? 'enabled' : 'disabled'})`).join('\n').slice(0, 1900);
      } else {
        requireAdmin(interaction);
        if (busyGuilds.has(guildId)) throw new Error('Wait for the current import to finish before changing games.');
        if (sub === 'add') {
          if (store.games(guildId).length >= 25) throw new Error('This version supports up to 25 games per server.');
          const game = Object.fromEntries(['key', 'name', 'template', 'direction'].map((key) => [key, interaction.options.getString(key, true)]));
          store.addGame(guildId, game);
          content = `Added **${safeName(game.name)}** as \`${game.key}\`. Use /backfill to import earlier matching posts.`;
        } else if (sub === 'enable' || sub === 'disable') {
          const key = interaction.options.getString('game', true);
          store.setEnabled(guildId, key, sub === 'enable');
          content = `Game \`${safeName(key)}\` ${sub === 'enable' ? 'enabled' : 'disabled'}. Stored scores are retained.`;
        } else {
          throw new Error('Unknown game command. Run npm run register to update the available commands.');
        }
      }
      break;
    }
    case 'leaderboard': {
      await interaction.editReply(buildLeaderboardView(store, guildId, {
        ownerId: interaction.user.id, gameKey: interaction.options.getString('game'),
        page: interaction.options.getInteger('page') || 1,
        period: interaction.options.getString('period') || 'monthly',
      }));
      return;
    }
    case 'score': {
      const key = interaction.options.getString('game', true);
      const game = requireGame(store, guildId, key);
      if (!game.enabled) throw new Error('Enable this game to query its stored scores.');
      const user = interaction.options.getUser('user') || interaction.user;
      const puzzle = interaction.options.getString('puzzle');
      const puzzleId = puzzle ? normalizePuzzle(puzzle) : null;
      if (puzzle && puzzleId === null) throw new Error('Puzzle must be a number or valid date, such as 2026-10-20, 20.10.2026, or October 20.');
      const rows = store.submissions(guildId).filter((row) => row.game_key === key && row.user_id === user.id && (!puzzle || row.puzzle === puzzleId))
        .sort((a, b) => (/^\d+$/.test(a.puzzle) && /^\d+$/.test(b.puzzle)
          ? Number(b.puzzle) - Number(a.puzzle) : b.puzzle.localeCompare(a.puzzle)) || b.created_at - a.created_at).slice(0, 10);
      content = `**${safeName(game.name)} scores for <@${user.id}>**\n${rows.map((row) => `${/^\d+$/.test(row.puzzle) ? '#' : ''}${row.puzzle}: **${number(row.score)}** — [message](https://discord.com/channels/${guildId}/${row.channel_id}/${row.message_id})`).join('\n') || 'No matching scores recorded.'}`;
      break;
    }
    case 'backfill': {
      requireAdmin(interaction);
      if (busyGuilds.has(guildId)) throw new Error('An import is already running for this server.');
      const channelId = store.channel(guildId);
      if (!channelId) throw new Error('Use /track to choose a channel first.');
      busyGuilds.add(guildId);
      try {
        const channel = await interaction.guild.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.messages) throw new Error('The tracked channel is unavailable. Use /track to select another.');
        const limit = interaction.options.getInteger('limit') || 100;
        let scanned = 0;
        let matched = 0;
        let before;
        while (scanned < limit) {
          const batch = await channel.messages.fetch({ limit: Math.min(100, limit - scanned), ...(before ? { before } : {}) });
          if (!batch.size) break;
          for (const message of batch.values()) {
            matched += store.ingest(message);
            scanned++;
          }
          before = batch.last().id;
        }
        content = `Scanned ${scanned} messages and processed ${matched} game submissions. Reimporting a message does not duplicate scores.`;
      } finally {
        busyGuilds.delete(guildId);
      }
      break;
    }
    default: throw new Error('Unknown command. Register commands again with npm run register.');
  }
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}
