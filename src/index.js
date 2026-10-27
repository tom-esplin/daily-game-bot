import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { config } from './config.js';
import { Store } from './store.js';
import { handleInteraction } from './handlers.js';

let store;
let client;
try {
  const settings = config();
  store = new Store(settings.databasePath);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: { parse: [] },
  });
  client.once(Events.ClientReady, (ready) => console.log(`Logged in as ${ready.user.tag}. Use /track to choose a channel.`));
  client.on(Events.MessageCreate, (message) => {
    try { store.ingest(message); } catch (error) { console.error('Could not record a message:', error.message); }
  });
  client.on(Events.MessageUpdate, async (_previous, message) => {
    if (!message.guildId || store.channel(message.guildId) !== message.channelId) return;
    try {
      if (message.partial) message = await message.fetch();
      store.ingest(message);
    } catch (error) { console.error('Could not update a message:', error.message); }
  });
  client.on(Events.MessageDelete, (message) => {
    try { if (message.guildId) store.removeMessage(message.guildId, message.id); }
    catch (error) { console.error('Could not remove a score:', error.message); }
  });
  client.on(Events.MessageBulkDelete, (messages) => {
    try { for (const message of messages.values()) if (message.guildId) store.removeMessage(message.guildId, message.id); }
    catch (error) { console.error('Could not remove scores:', error.message); }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    try { await handleInteraction(interaction, store); }
    catch (error) {
      console.error('Command failed:', error.message);
      if (interaction.isAutocomplete()) {
        if (!interaction.responded) await interaction.respond([]).catch(() => {});
        return;
      }
      const response = { content: error.message.slice(0, 1900), allowedMentions: { parse: [] } };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
      } catch (replyError) { console.error('Could not send command error:', replyError.message); }
    }
  });
  client.on(Events.Error, (error) => console.error('Discord client error:', error.message));
  const stop = () => { client.destroy(); store.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await client.login(settings.token);
} catch (error) {
  console.error('Bot startup failed:', error.message);
  client?.destroy();
  store?.close();
  process.exitCode = 1;
}
