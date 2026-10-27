import { normalizePuzzle } from './parser.js';

export const CODENAMES_GAME = {
  key: 'codenames', name: 'Codenames Daily', direction: 'higher', parser: 'codenames',
  template: 'CODENAMES DAILY\n{puzzle}\n{rounds}',
};

export function parseCodenames(content) {
  if (typeof content !== 'string' || content.length > 20000) return null;
  const lines = content.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  const header = lines.findIndex((line) => /^CODENAMES DAILY$/i.test(line));
  if (header === -1) return null;
  const body = lines.slice(header + 1).filter(Boolean);
  const puzzle = normalizePuzzle(body[0] || '');
  if (!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(body[0] || '') || puzzle === null) return null;
  const rounds = [];
  for (const line of body.slice(1)) {
    if (/^Can you beat this\?$/i.test(line) || /^https:\/\/(?:www\.)?codenames\.game\/daily(?:[/?#]|$)/i.test(line)) break;
    const match = /^(.+?)[ \t]+([1-9]\d?)[ \t]+((?:[✅❌]\uFE0F?[ \t]*)+)$/u.exec(line);
    if (!match || rounds.length >= 4) return null;
    const target = Number(match[2]);
    const outcomes = [...match[3].matchAll(/[✅❌]/gu)].map((result) => result[0]);
    const correct = outcomes.filter((outcome) => outcome === '✅').length;
    const incorrect = outcomes.length - correct;
    if (target > 25 || outcomes.length > target || incorrect > 1
      || (incorrect === 1 && outcomes.at(-1) !== '❌')
      || (incorrect === 0 && outcomes.length !== target)) return null;
    rounds.push({ correct, target });
  }
  if (rounds.length !== 4) return null;
  // Accumulate an exact fraction in tenths of a point, flooring only the final total.
  // With four targets capped at 25, these integer products remain safely below 2^53.
  let numerator = 0;
  let denominator = 1;
  for (const [index, round] of rounds.entries()) {
    const weight = index < 3 ? 300 : 100;
    numerator = numerator * round.target + weight * round.correct * denominator;
    denominator *= round.target;
  }
  return { puzzle, score: Math.floor(numerator / (10 * denominator)) };
}
