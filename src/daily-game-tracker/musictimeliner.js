import { normalizePuzzle } from './parser.js';

export const MUSIC_TIMELINER_GAME = {
  key: 'musictimeliner', name: 'Music Timeliner', direction: 'higher', parser: 'musictimeliner',
  template: 'Music Timeliner #{puzzle}\n{squares}',
};

export function parseMusicTimeliner(content) {
  if (typeof content !== 'string' || content.length > 20000) return null;
  const lines = content.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  const headerPattern = /^Music[ \t]+Timeliner[ \t]+#(\d+)$/i;
  const header = lines.findIndex((line) => headerPattern.test(line));
  if (header === -1) return null;
  const puzzle = normalizePuzzle(headerPattern.exec(lines[header])[1]);
  if (puzzle === null) return null;
  let green = 0;
  let total = 0;
  for (const line of lines.slice(header + 1)) {
    if (!line) continue;
    if (/^https:\/\/(?:www\.)?musictimeliner\.com\/?(?:[?#]\S*)?$/i.test(line)) break;
    const squares = line.replace(/:green_square:/gi, '🟩').replace(/:red_square:/gi, '🟥')
      .replace(/[ \t\uFE0F]/g, '');
    if (!/^[🟩🟥]+$/u.test(squares)) return null;
    for (const square of squares) {
      total++;
      if (square === '🟩') green++;
    }
  }
  // A title/link without a result is missing data; an all-red result is a valid zero.
  return total > 0 && total <= 8 ? { puzzle, score: Math.floor(green * 12.5) } : null;
}
