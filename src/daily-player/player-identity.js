import { MessageFlags } from 'discord.js';

export const AI_PLAYER_NAME = 'lnklingbot';
export const AI_PLAYER_PREVIOUS_NAMES = ['lnklingblot', 'Inklingbot'];

export function aiResultContent(shareText, name = AI_PLAYER_NAME) {
  return `**${name} · AI player**\n\n${shareText}`;
}

export function resultEmbedsSuppressed(message) {
  return typeof message.flags?.has === 'function' ? message.flags.has(MessageFlags.SuppressEmbeds)
    : Boolean(Number(message.flags?.bitfield ?? message.flags ?? 0) & MessageFlags.SuppressEmbeds);
}

export function playerLabel(store, userId) {
  return store?.isAIPlayer?.(userId) ? `**${AI_PLAYER_NAME}**` : `<@${userId}>`;
}
