import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const gameOption = (option) => option.setName('game').setDescription('Game key, for example krillion').setMaxLength(32).setAutocomplete(true);

export const commands = [
  new SlashCommandBuilder().setName('track').setDescription('Choose the channel to track daily game scores')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) => option.setName('channel').setDescription('Channel containing shared scores').setRequired(true)
      .addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show monthly or all-time score totals')
    .addStringOption(gameOption)
    .addIntegerOption((option) => option.setName('page').setDescription('Page number').setMinValue(1))
    .addStringOption((option) => option.setName('period').setDescription('Defaults to the current month')
      .addChoices({ name: 'Monthly', value: 'monthly' }, { name: 'All Time', value: 'alltime' })),
  new SlashCommandBuilder().setName('score').setDescription('Show a player’s recent scores for one game')
    .addStringOption((option) => gameOption(option).setRequired(true))
    .addUserOption((option) => option.setName('user').setDescription('Player; defaults to you'))
    .addStringOption((option) => option.setName('puzzle').setDescription('Optional puzzle number or date, e.g. 2026-10-20').setMaxLength(30)),
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
  new SlashCommandBuilder().setName('backfill').setDescription('Import recent channel messages (Manage Server permission required)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) => option.setName('limit').setDescription('Messages to scan; defaults to 100').setMinValue(1).setMaxValue(1000)),
].map((command) => command.setDMPermission(false).toJSON());
