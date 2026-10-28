import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { DEFAULT_BACKFILL_LIMIT, MAX_BACKFILL_LIMIT } from './backfill.js';

const gameOption = (option) => option.setName('game').setDescription('Game key, for example krillion').setMaxLength(32).setAutocomplete(true);

export const commands = [
  new SlashCommandBuilder().setName('explain-dailys').setDescription('Learn game scoring, leaderboard rules, and player commands'),
  new SlashCommandBuilder().setName('track').setDescription('Add a channel to track daily game scores')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) => option.setName('channel').setDescription('Channel containing shared scores').setRequired(true)
      .addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('untrack').setDescription('Stop tracking a channel and keep its recorded scores')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) => option.setName('channel').setDescription('Channel to stop tracking').setRequired(true)
      .addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('channels').setDescription('List tracked score channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) => option.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show monthly or all-time score totals')
    .addStringOption(gameOption)
    .addStringOption((option) => option.setName('period').setDescription('Defaults to the current month')
      .addChoices({ name: 'Monthly', value: 'monthly' }, { name: 'All Time', value: 'alltime' })),
  new SlashCommandBuilder().setName('score').setDescription('Show a player’s monthly or all-time total')
    .addStringOption(gameOption)
    .addUserOption((option) => option.setName('user').setDescription('Player; defaults to you'))
    .addStringOption((option) => option.setName('period').setDescription('Defaults to the current month')
      .addChoices({ name: 'Monthly', value: 'monthly' }, { name: 'All Time', value: 'alltime' })),
  new SlashCommandBuilder().setName('game').setDescription('List or configure tracked games')
    .addSubcommand((sub) => sub.setName('list').setDescription('Show game keys and parsing templates'))
    .addSubcommand((sub) => sub.setName('add').setDescription('Add a game (Manage Server permission required)')
      .addStringOption((option) => option.setName('key').setDescription('Unique lowercase key, e.g. wordle').setRequired(true).setMaxLength(32))
      .addStringOption((option) => option.setName('name').setDescription('Display name').setRequired(true).setMaxLength(60))
      .addStringOption((option) => option.setName('template').setDescription('Use {puzzle}, {score}, \\n for new lines, and {skip} on its own line to skip a block').setRequired(true).setMaxLength(300))
      .addStringOption((option) => option.setName('direction').setDescription('Which score wins?').setRequired(true)
        .addChoices({ name: 'Higher is better', value: 'higher' }, { name: 'Lower is better', value: 'lower' })))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Enable a game (Manage Server permission required)')
      .addStringOption((option) => gameOption(option).setRequired(true)))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Pause a game (Manage Server permission required)')
      .addStringOption((option) => gameOption(option).setRequired(true))),
  new SlashCommandBuilder().setName('backfill').setDescription('Import tracked channel history (Manage Server permission required)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) => option.setName('limit')
      .setDescription(`Messages per channel; defaults to ${DEFAULT_BACKFILL_LIMIT}, maximum ${MAX_BACKFILL_LIMIT.toLocaleString('en-US')}`)
      .setMinValue(1).setMaxValue(MAX_BACKFILL_LIMIT))
    .addChannelOption((option) => option.setName('channel').setDescription('Optional tracked channel; defaults to all tracked channels')
      .addChannelTypes(ChannelType.GuildText)),
].map((command) => command.setDMPermission(false).toJSON());
