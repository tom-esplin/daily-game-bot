import { createHash } from 'node:crypto';
import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { DAILY_PLAYER } from './daily-player-config.js';
import { AI_PLAYER_NAME, AI_PLAYER_PREVIOUS_NAMES, aiResultContent, resultEmbedsSuppressed } from './player-identity.js';
import { DailyPlayerModel } from './daily-player-model.js';
import { playDailyGame } from './daily-browser.js';
import { dailyResultMarker, parseDailyResult } from './daily-results.js';

export function dailyPlayerWindow(now = new Date(), settings = DAILY_PLAYER) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  if (Number(parts.hour) * 60 + Number(parts.minute) < settings.hour * 60 + settings.minute) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dailyDestination(server, gameKey) {
  return gameKey === 'codenames' ? server.codenamesChannelId : server.dailyChannelId;
}

export async function findDailyDelivery(channel, botId, job) {
  const marker = dailyResultMarker(job.game_key, job.puzzle);
  const result = JSON.parse(job.result_json);
  let before;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = messages.find((message) => {
      if (message.author.id !== botId) return false;
      const matchesContent = [AI_PLAYER_NAME, ...AI_PLAYER_PREVIOUS_NAMES]
        .some((name) => message.content === aiResultContent(result.shareText, name));
      const oldBanner = message.embeds.some((embed) => embed.footer?.text === marker);
      if (!oldBanner && !matchesContent) return false;
      const parsed = parseDailyResult(job.game_key, message.content, message.createdTimestamp);
      return parsed?.puzzle === job.puzzle && parsed.score === result.score;
    });
    if (found) return found;
    const oldest = messages.last();
    if (!oldest || oldest.createdTimestamp < job.created_at || messages.size < 100) return null;
    before = oldest.id;
  }
}

export async function removeDailyResultBanners(client, store, { settings = DAILY_PLAYER, logger = console } = {}) {
  for (const job of store.pendingAIBannerCleanup(client.user.id)) {
    if (!settings.servers[job.guild_id]) continue;
    try {
      const guild = client.guilds.cache.get(job.guild_id);
      if (!guild) continue;
      const channel = await guild.channels.fetch(job.channel_id);
      const message = await channel.messages.fetch(job.message_id);
      if (message.author.id !== client.user.id) throw new Error('Result message author does not match the bot.');
      const content = aiResultContent(JSON.parse(job.result_json).shareText);
      if (message.content !== content || message.embeds.length || !resultEmbedsSuppressed(message)) {
        await message.edit({ content, embeds: [], flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
      }
      store.finishAIBannerCleanup(job);
    } catch (error) {
      if (error.code === 10008) store.finishAIBannerCleanup(job); // The message was deleted.
      else logger.error(`Could not remove AI result banner (${job.message_id}):`, error.message);
    }
  }
}

export function normalizedChannelName(name = '') {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

async function destinationChannel(client, guildId, channelId, { validateChannelNames = false, gameKey, trackedChannelIds } = {}) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild || !channelId) throw new Error('Configure a destination channel ID for this server.');
  let channel = await guild.channels.fetch(channelId).catch(() => null);
  if (validateChannelNames) {
    const names = gameKey === 'codenames' ? ['codenames-daily', 'daily-codenames'] : ['daily-games'];
    const matches = (entry) => entry && entry.guildId === guildId && names.includes(normalizedChannelName(entry.name));
    if (!matches(channel)) {
      const fetched = await Promise.allSettled((trackedChannelIds || []).map((id) => id === channelId
        ? Promise.resolve(channel) : guild.channels.fetch(id)));
      const tracked = fetched.filter((entry) => entry.status === 'fulfilled' && entry.value).map((entry) => entry.value);
      const candidates = tracked.filter(matches);
      if (candidates.length === 1) [channel] = candidates;
      else {
        const available = tracked.map((entry) => `#${entry.name} (${entry.id})`).join(', ') || 'none available';
        throw new Error(`Configured channel ${channelId} is ${channel ? '#' + channel.name : 'unavailable'}; expected ${names.map((name) => '#' + name).join(' or ')}. Found ${candidates.length} matching tracked channels. Tracked channels: ${available}. Check src/daily-player/daily-player-config.js.`);
      }
    }
  }
  if (!channel || channel.guildId !== guildId || typeof channel.send !== 'function'
    || !channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) {
    throw new Error('Daily results require View Channel, Send Messages, Embed Links, and Read Message History.');
  }
  return channel;
}

export async function runDailyPlayer(client, store, {
  settings = DAILY_PLAYER, now = new Date(), logger = console, play = playDailyGame,
  modelFactory = (options) => new DailyPlayerModel(settings, options), signal,
} = {}) {
  if (!settings.enabled) return;
  const tickStartedAt = Date.now();
  const date = dailyPlayerWindow(now, settings);
  const servers = Object.entries(settings.servers).filter(([id]) => client.guilds.cache.has(id));
  if (!servers.length) return;
  await removeDailyResultBanners(client, store, { settings, logger });
  store.registerAIPlayer(client.user.id);
  store.expireDailyRuns(Date.now(), settings.maxRuntimeMs);
  const destinations = new Map();
  const resolveDestination = async (guildId, server, gameKey) => {
    const key = `${guildId}:${gameKey}`;
    if (!destinations.has(key)) {
      const requestedId = dailyDestination(server, gameKey);
      const channel = await destinationChannel(client, guildId, requestedId,
        { ...server, gameKey, trackedChannelIds: store.channels(guildId) });
      if (!store.isTracked(guildId, channel.id)) throw new Error('Run /track for the daily results channel.');
      destinations.set(key, channel);
      logger.log?.(`Daily player destination (${guildId}, ${gameKey}): #${channel.name} (${channel.id})${channel.id !== requestedId ? ' — resolved from tracked channels' : ''}.`);
    }
    return destinations.get(key);
  };
  const preflights = new Map();
  if (date) for (const [gameKey, game] of Object.entries(settings.games)) {
    if (signal?.aborted) break;
    if (dailyPlayerWindow(new Date(now.getTime() + Date.now() - tickStartedAt), settings) !== date) break;
    if (!game.enabled || !game.verified || store.dailyRun(date, gameKey)) continue;
    const eligible = [];
    for (const [guildId, server] of servers) {
      if (!store.game(guildId, gameKey)?.enabled) continue;
      try {
        await resolveDestination(guildId, server, gameKey);
        eligible.push(guildId);
      } catch (error) { logger.error(`Daily player destination unavailable (${guildId}, ${gameKey}):`, error.message); }
    }
    if (!eligible.length) continue;
    let model;
    try {
      model = modelFactory({ onUsage: (usage) => store.recordAIUsage(date, gameKey, usage) });
      // Preflight once before any attempt begins; access failures can retry without consuming a game.
      const timeout = AbortSignal.timeout(30000);
      const audio = gameKey === 'musictimeliner';
      if (!preflights.has(audio)) preflights.set(audio, model.preflight(signal ? AbortSignal.any([signal, timeout]) : timeout, { audio }));
      await preflights.get(audio);
    } catch (error) { logger.error(`Daily player model preflight failed (${gameKey}):`, error.message); continue; }
    const startedAt = Date.now();
    if (!store.claimDailyRun(date, gameKey, startedAt, settings.maxRuntimeMs)) continue;
    const heartbeat = setInterval(() => store.touchDailyRun(date, gameKey, Date.now()), 10000);
    try {
      const result = await play(gameKey, settings, model, { signal });
      store.finishDailyRun(date, gameKey, { ...result, guildIds: eligible }, Date.now());
      logger.log?.(`Daily player completed ${gameKey} #${result.puzzle}: ${result.score}.`);
    } catch (error) {
      store.failDailyRun(date, gameKey, error.message, Date.now());
      logger.error(`Daily player failed (${gameKey}):`, error.message);
    } finally { clearInterval(heartbeat); }
  }
  // Include previous completed runs so a delivery failure or restart never requires replaying a game.
  for (const run of store.completedDailyRuns()) for (const [guildId, server] of servers) {
    const result = JSON.parse(run.result_json);
    if (!result.guildIds.includes(guildId)) continue;
    const game = settings.games[run.game_key];
    if (!game?.enabled || !game.verified || !store.game(guildId, run.game_key)?.enabled) continue;
    try {
      const channel = await resolveDestination(guildId, server, run.game_key);
      store.queueAIDelivery(guildId, channel.id, client.user.id, result, Date.now());
    } catch (error) { logger.error(`Daily result destination unavailable (${guildId}, ${run.game_key}):`, error.message); }
  }
  for (const job of store.pendingAIDeliveries()) {
    if (!settings.servers[job.guild_id] || job.user_id !== client.user.id) continue;
    if (!settings.games[job.game_key]?.enabled || !settings.games[job.game_key]?.verified
      || !store.game(job.guild_id, job.game_key)?.enabled || !store.isTracked(job.guild_id, job.channel_id)) continue;
    try {
      const channel = await destinationChannel(client, job.guild_id, job.channel_id,
        { ...settings.servers[job.guild_id], gameKey: job.game_key });
      let message = await findDailyDelivery(channel, client.user.id, job);
      if (!message) {
        const result = JSON.parse(job.result_json);
        message = await channel.send({ content: aiResultContent(result.shareText),
          flags: MessageFlags.SuppressEmbeds,
          allowedMentions: { parse: [] },
          nonce: createHash('sha256').update(`daily:${job.guild_id}:${job.game_key}:${job.puzzle}`).digest('hex').slice(0, 24),
          enforceNonce: true,
        });
      }
      store.completeAIDelivery(job, message);
    } catch (error) { logger.error(`Daily result delivery failed (${job.guild_id}, ${job.game_key}):`, error.message); }
  }
}

export function startDailyPlayer(client, store, settings = DAILY_PLAYER) {
  if (!settings.enabled) return async () => {};
  const controller = new AbortController();
  let pending;
  const tick = () => {
    if (pending || controller.signal.aborted) return;
    pending = runDailyPlayer(client, store, { settings, signal: controller.signal })
      .catch((error) => console.error('Daily player scheduler failed:', error.message)).finally(() => { pending = null; });
  };
  const timer = setInterval(tick, settings.checkIntervalMs);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); controller.abort(); await pending; };
}
