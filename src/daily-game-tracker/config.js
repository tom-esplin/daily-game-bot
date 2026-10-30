export function config({ registration = false } = {}) {
  const required = registration ? ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'] : ['DISCORD_TOKEN'];
  const missing = required.filter((key) => !process.env[key] || process.env[key].startsWith('your_'));
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in .env. See .env.example and README.md.`);
  return {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    databasePath: process.env.DATABASE_PATH || './data/scores.sqlite',
  };
}
