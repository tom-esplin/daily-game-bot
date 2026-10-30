import { parseSubmission } from '../daily-game-tracker/parser.js';
import { parseCodenames } from '../daily-game-tracker/codenames.js';
import { parseMusicTimeliner } from '../daily-game-tracker/musictimeliner.js';

export function parseDailyResult(gameKey, text, timestamp = Date.now()) {
  if (typeof text !== 'string' || text.length > 1900) return null;
  if (gameKey === 'codenames') return parseCodenames(text);
  if (gameKey === 'musictimeliner') {
    const squares = text.replace(/:green_square:/gi, '🟩').replace(/:red_square:/gi, '🟥').match(/[🟩🟥]/gu) || [];
    return squares.length === 8 ? parseMusicTimeliner(text) : null;
  }
  const template = gameKey === 'krillion' ? 'Krillion #{puzzle}\n{score}'
    : gameKey === 'maptapp' ? 'www.maptap.gg {puzzle}\n{skip}\nFinal score: {score}' : null;
  const result = template ? parseSubmission(text, template, timestamp) : null;
  const max = gameKey === 'krillion' ? 700 : 1000;
  return result && Number.isInteger(result.score) && result.score >= 0 && result.score <= max ? result : null;
}

export function dailyResultMarker(gameKey, puzzle) {
  return `AI daily result · ${gameKey} · ${puzzle}`;
}

// Some browsers expose the game's native copy popup instead of a clipboard write.
// Require both its real share heading and publisher link; never construct a result from board guesses.
export function visibleCodenamesShare(text) {
  if (typeof text !== 'string' || text.length > 20000) return null;
  const normalized = text.replace(/\r\n/g, '\n');
  const header = /^CODENAMES DAILY[ \t]*$/im.exec(normalized);
  if (!header) return null;
  const candidate = normalized.slice(header.index);
  const footer = /^https:\/\/(?:www\.)?codenames\.game\/daily(?:[/?#]\S*)?[ \t]*$/im.exec(candidate);
  if (!footer) return null;
  const share = candidate.slice(0, footer.index + footer[0].length).trim();
  return parseDailyResult('codenames', share) ? share : null;
}
