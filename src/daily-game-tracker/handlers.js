import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildLeaderboardView, handleLeaderboardComponent } from './leaderboard-view.js';
import { buildUserScoreView } from './score-view.js';
import { buildExplainView, handleExplainComponent } from './explain-view.js';
import { DEFAULT_BACKFILL_LIMIT, importChannelHistory, validateBackfillLimit } from './backfill.js';

const number = (value) => Number(value.toFixed(2)).toString();
const safeName = (value) => value.replace(/[`*_~|<>@\\]/g, '').replace(/[\r\n]/g, ' ');
const busyGuilds = new Set();

function requireAdmin(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need Manage Server permission to change tracking settings or import messages.');
  }
}

export async function handleInteraction(interaction, store) {
  if (interaction.isButton?.() && interaction.customId?.startsWith('dailyhelp:')) {
    await handleExplainComponent(interaction, store);
    return;
  }
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
    case 'explain-dailys': {
      await interaction.editReply(buildExplainView(store, guildId, {
        ownerId: interaction.user.id,
      }));
      return;
    }
    case 'track': {
      requireAdmin(interaction);
      if (busyGuilds.has(guildId)) throw new Error('Wait for the current import to finish before changing tracked channels.');
      const channel = interaction.options.getChannel('channel', true);
      const permissions = channel.permissionsFor(interaction.client.user);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new Error('Give the bot View Channel and Read Message History permissions in that channel.');
      }
      const added = store.track(guildId, channel.id);
      content = `${added ? 'Now tracking' : 'Already tracking'} <#${channel.id}>. ${store.channels(guildId).length} channels tracked. Use /backfill to import older posts.`;
      break;
    }
    case 'untrack': {
      requireAdmin(interaction);
      if (busyGuilds.has(guildId)) throw new Error('Wait for the current import to finish before changing tracked channels.');
      const channel = interaction.options.getChannel('channel', true);
      const removed = store.untrack(guildId, channel.id);
      content = removed ? `Stopped tracking <#${channel.id}>. Recorded scores are retained.` : `<#${channel.id}> is not tracked.`;
      break;
    }
    case 'channels': {
      requireAdmin(interaction);
      const channels = store.channels(guildId);
      const page = interaction.options.getInteger('page') || 1;
      const pages = Math.max(1, Math.ceil(channels.length / 20));
      if (page > pages) throw new Error(`Choose a page between 1 and ${pages}.`);
      content = channels.length ? `**Tracked channels (${channels.length})**\n${channels.slice((page - 1) * 20, page * 20).map((id) => `<#${id}>`).join('\n')}\nPage ${page}/${pages}`
        : 'No tracked channels. Use /track to add a score channel.';
      break;
    }
    case 'game': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const games = store.games(guildId);
        content = games.length ? games.map((game) => {
          let description = `Template: ${safeName(game.template.replace(/\n/g, '\\n'))}`;
          if (game.parser === 'codenames') description = 'Scoring: rounds 1–3 each earn up to 30 points; an optional round 4 adds up to 10 bonus points only after three perfect main rounds. Final total rounded down; maximum 100 (90 without the bonus).';
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
        period: interaction.options.getString('period') || 'monthly',
      }));
      return;
    }
    case 'score': {
      const user = interaction.options.getUser('user') || interaction.user;
      await interaction.editReply(buildUserScoreView(store, guildId, {
        userId: user.id, gameKey: interaction.options.getString('game'),
        period: interaction.options.getString('period') || 'monthly',
      }));
      return;
    }
    case 'backfill': {
      requireAdmin(interaction);
      if (busyGuilds.has(guildId)) throw new Error('An import is already running for this server.');
      const selected = interaction.options.getChannel('channel');
      const trackedChannels = store.channels(guildId);
      if (!trackedChannels.length) throw new Error('Use /track to add a channel first.');
      if (selected && !trackedChannels.includes(selected.id)) throw new Error('That channel is not tracked. Add it with /track first.');
      const channelIds = selected ? [selected.id] : trackedChannels;
      const limit = interaction.options.getInteger('limit') ?? DEFAULT_BACKFILL_LIMIT;
      validateBackfillLimit(limit);
      let scanned = 0;
      let matched = 0;
      let completed = 0;
      const failures = [];
      let canUpdateProgress = true;
      const updateProgress = async (content) => {
        if (!canUpdateProgress) return;
        try {
          await interaction.editReply({ content, allowedMentions: { parse: [] } });
        } catch (error) {
          canUpdateProgress = false;
          console.warn('Could not update backfill progress:', error.message);
        }
      };
      busyGuilds.add(guildId);
      try {
        for (const [index, channelId] of channelIds.entries()) {
          try {
            const channel = await interaction.guild.channels.fetch(channelId);
            if (!channel?.isTextBased() || !channel.messages) throw new Error('Channel unavailable or unreadable');
            await importChannelHistory(channel, {
              ingest(message) {
                const count = store.ingest(message);
                scanned++;
                matched += count;
                return count;
              },
            }, {
              limit,
              onProgress: async ({ scanned: channelScanned }) => {
                await updateProgress(`Importing channel ${index + 1}/${channelIds.length}: <#${channelId}> — scanned ${channelScanned.toLocaleString('en-US')} of up to ${limit.toLocaleString('en-US')} messages. Total: ${scanned.toLocaleString('en-US')} messages; ${matched.toLocaleString('en-US')} game submissions.`);
              },
            });
            completed++;
          } catch (error) {
            console.error(`Backfill failed for channel ${channelId}:`, error.message);
            failures.push(channelId);
          }
          if (index < channelIds.length - 1) {
            await updateProgress(`Importing… ${index + 1}/${channelIds.length} channels processed; scanned ${scanned.toLocaleString('en-US')} messages and processed ${matched.toLocaleString('en-US')} game submissions.`);
          }
        }
        content = `Scanned ${scanned} messages and processed ${matched} game submissions across ${completed}/${channelIds.length} channels. Reimporting a message does not duplicate scores.`;
        if (failures.length) content += `\nCould not finish ${failures.length} channels: ${failures.slice(0, 20).map((id) => `<#${id}>`).join(', ')}${failures.length > 20 ? ', …' : ''}. Check access and retry those channels with /backfill channel.`;
      } finally {
        busyGuilds.delete(guildId);
      }
      break;
    }
    default: throw new Error('Unknown command. Register commands again with npm run register.');
  }
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}
