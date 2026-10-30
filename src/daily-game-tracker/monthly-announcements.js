import { createHash } from 'node:crypto';
import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { MONTHLY_ANNOUNCEMENTS as settings } from './announcements-config.js';
import { LEADERBOARD_TIME_ZONE, leaderboardPeriodLabel, submissionsForPeriod } from './leaderboard-period.js';
import { leaderboard } from './rankings.js';
import { formatPlayerScore } from './score-view.js';

const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: LEADERBOARD_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function monthlyAnnouncementWindow(now = new Date()) {
  const parts = Object.fromEntries(clock.formatToParts(now).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  if (parts.day !== lastDay || parts.hour * 60 + parts.minute < settings.hour * 60 + settings.minute) return null;
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const cutoff = Date.UTC(parts.year, parts.month - 1, lastDay, settings.hour, settings.minute) - offset;
  return { month: `${parts.year}-${String(parts.month).padStart(2, '0')}`, cutoff };
}

export function announcementMarker(month) {
  return `Daily games monthly winners · ${month}`;
}

async function winnerUsername(client, winner, submissions) {
  try {
    const user = await client.users.fetch(winner.userId, { force: true });
    if (user?.username) return user.username;
  } catch { /* Fall back to the latest username recorded with a submitted score. */ }
  return submissions.filter((row) => row.user_id === winner.userId)
    .sort((a, b) => b.created_at - a.created_at)[0]?.username || '';
}

async function createPayload(client, store, guildId, window) {
  const cutoffDate = new Date(window.cutoff);
  const submissions = submissionsForPeriod(store.submissions(guildId, { beforeTimestamp: window.cutoff }), 'monthly', cutoffDate);
  const winners = leaderboard(submissions, store.games(guildId, true)).slice(0, 3);
  if (!winners.length) return null;
  const usernames = await Promise.all(winners.map((winner) => winnerUsername(client, winner, submissions)));
  const includeEasterEgg = !usernames.some((name) => name.toLowerCase() === settings.easterEggUsername.toLowerCase());
  const embed = new EmbedBuilder().setColor(0xF1C40F)
    .setTitle(`🏆 ${leaderboardPeriodLabel('monthly', cutoffDate)} winners`)
    .setDescription(winners.map((winner, index) => `${['🥇', '🥈', '🥉'][index]} ${formatPlayerScore(winner.userId, winner.points, winner.count, store)}`).join('\n\n'))
    .setFooter({ text: `${announcementMarker(window.month)} · Scores through 6:00 pm ${LEADERBOARD_TIME_ZONE}` })
    .setTimestamp(cutoffDate);
  return {
    ...(includeEasterEgg ? { content: settings.easterEggText } : {}),
    embeds: [embed.toJSON()], allowedMentions: { parse: [] },
  };
}

async function announcementChannel(client, guild, savedChannelId) {
  const channelId = savedChannelId || settings.channelIds[guild.id];
  let channel;
  if (channelId) channel = await guild.channels.fetch(channelId);
  else {
    const channels = await guild.channels.fetch();
    const matches = [...channels.values()].filter((entry) => entry
      && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(entry.type)
      && entry.name.toLowerCase() === settings.channelName.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected one #${settings.channelName} channel; set this server's channel ID in src/daily-game-tracker/announcements-config.js.`);
    [channel] = matches;
  }
  if (!channel || channel.guildId !== guild.id || typeof channel.send !== 'function') throw new Error('The winners announcement channel is unavailable.');
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
  if (!channel.permissionsFor(client.user)?.has(required)) throw new Error('Winners announcements need View Channel, Send Messages, Embed Links, and Read Message History in #general.');
  return channel;
}

async function findExistingAnnouncement(channel, client, job) {
  const footer = JSON.parse(job.payload_json).embeds[0].footer.text;
  let before;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!messages.size) return null;
    const existing = messages.find((message) => message.author.id === client.user.id
      && message.embeds.some((embed) => embed.footer?.text === footer));
    if (existing) return existing;
    const oldest = messages.last();
    if (oldest.createdTimestamp < job.created_at || messages.size < 100) return null;
    before = oldest.id;
  }
}

export async function runMonthlyAnnouncements(client, store, { now = new Date(), logger = console } = {}) {
  const window = monthlyAnnouncementWindow(now);
  for (const guild of client.guilds.cache.values()) {
    try {
      const freshMonths = new Set();
      if (window && !store.monthlyAnnouncement(guild.id, window.month) && store.games(guild.id, true).length) {
        const payload = await createPayload(client, store, guild.id, window);
        const job = store.createMonthlyAnnouncement(guild.id, window.month, payload, now.getTime());
        if (job.created) freshMonths.add(window.month);
      }
      for (const job of store.pendingMonthlyAnnouncements(guild.id)) {
        const channel = await announcementChannel(client, guild, job.channel_id);
        // On retries/restarts, check history for a send that succeeded before its receipt was saved.
        let sent = freshMonths.has(job.month) ? null : await findExistingAnnouncement(channel, client, job);
        if (!sent) {
          store.setMonthlyAnnouncementChannel(guild.id, job.month, channel.id);
          const nonce = createHash('sha256').update(`${guild.id}:${job.month}`).digest('hex').slice(0, 24);
          sent = await channel.send({ ...JSON.parse(job.payload_json), nonce, enforceNonce: true });
        }
        store.finishMonthlyAnnouncement(guild.id, job.month, channel.id, sent.id);
      }
    } catch (error) {
      logger.error(`Monthly winners announcement failed for server ${guild.id}:`, error.message);
    }
  }
  await runMonthlyCelebrations(client, store, { now, logger });
}

export async function runMonthlyCelebrations(client, store, { now = new Date(), logger = console } = {}) {
  const window = monthlyAnnouncementWindow(now);
  for (const guild of client.guilds.cache.values()) {
    try {
      if (window && !store.celebration(guild.id, window.month)) {
        const submissions = submissionsForPeriod(store.submissions(guild.id, { beforeTimestamp: window.cutoff }), 'monthly', new Date(window.cutoff));
        const rows = leaderboard(submissions, store.games(guild.id, true));
        const ai = rows.find((row) => row.userId === client.user.id && store.isAIPlayer(row.userId));
        const winners = ai ? rows.filter((row) => !store.isAIPlayer(row.userId) && row.points > ai.points + 1e-9) : [];
        let payload = null;
        if (winners.length) {
          const names = winners.map((row) => `<@${row.userId}>`).join(', ');
          const overflow = names.length > 3700;
          payload = {
            embeds: [{ color: 0x57F287, title: '🎉 You beat lnklingbot this month!',
              description: overflow ? 'Congratulations to everyone listed in the attached results!' : `Congratulations to: ${names}!`,
              footer: { text: `Daily games AI celebration · ${window.month}` },
            }], allowedMentions: { parse: [] },
            ...(overflow ? { attachmentText: winners.map((row) => {
              const name = submissions.find((entry) => entry.user_id === row.userId)?.username || row.userId;
              return `${name} (${row.userId}): ${row.points.toFixed(2)} pts`;
            }).join('\n') } : {}),
          };
        }
        store.queueCelebration(guild.id, window.month, payload, now.getTime());
      }
      for (const job of store.pendingCelebrations(guild.id)) {
        const channel = await announcementChannel(client, guild, job.channel_id);
        let message = await findExistingAnnouncement(channel, client, job);
        if (!message) {
          store.setCelebrationChannel(guild.id, job.month, channel.id);
          const { attachmentText, ...payload } = JSON.parse(job.payload_json);
          message = await channel.send({ ...payload,
            ...(attachmentText ? { files: [{ attachment: Buffer.from(attachmentText), name: 'people-who-beat-lnklingbot.txt' }] } : {}),
            nonce: createHash('sha256').update(`celebration:${guild.id}:${job.month}`).digest('hex').slice(0, 24), enforceNonce: true });
        }
        store.finishCelebration(guild.id, job.month, channel.id, message.id);
      }
    } catch (error) { logger.error(`Monthly AI celebration failed for server ${guild.id}:`, error.message); }
  }
}

export function startMonthlyAnnouncements(client, store) {
  let pending = null;
  let stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = runMonthlyAnnouncements(client, store)
      .catch((error) => console.error('Monthly announcement scheduler failed:', error.message))
      .finally(() => { pending = null; });
  };
  const timer = setInterval(tick, settings.checkIntervalMs);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
