import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { config } from './config.js';

try {
  const settings = config({ registration: true });
  await new REST({ version: '10' }).setToken(settings.token).put(
    Routes.applicationGuildCommands(settings.clientId, settings.guildId), { body: commands },
  );
  console.log(`Registered ${commands.length} commands for server ${settings.guildId}.`);
} catch (error) {
  console.error('Command registration failed:', error.message);
  process.exitCode = 1;
}
