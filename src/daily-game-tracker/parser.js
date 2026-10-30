const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const months = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const monthPattern = `(?:${months.join('|')})`;
const namedDatePattern = `${monthPattern}[ \\t]+\\d{1,2}(?:,?[ \\t]+\\d{4})?`;
const puzzlePattern = `(?:${namedDatePattern}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d+)(?![\\w.,-])`;

function calendarDate(year, month, day) {
  if (year < 1000 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    ? date : null;
}

// Dates are stored with a year so successive years do not share one puzzle.
export function normalizePuzzle(value, referenceTimestamp = Date.now()) {
  value = value.trim();
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? String(number) : null;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const date = calendarDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return date ? date.toISOString().slice(0, 10) : null;
  }
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (dotted) {
    const date = calendarDate(Number(dotted[3]), Number(dotted[2]) - 1, Number(dotted[1]));
    return date ? date.toISOString().slice(0, 10) : null;
  }
  const named = new RegExp(`^(${monthPattern})[ \\t]+(\\d{1,2})(?:,?[ \\t]+(\\d{4}))?$`, 'i').exec(value);
  if (!named) return null;
  const month = months.findIndex((name) => name.toLowerCase() === named[1].toLowerCase());
  const reference = new Date(referenceTimestamp);
  if (!Number.isFinite(reference.getTime())) return null;
  const year = reference.getUTCFullYear();
  const years = named[3] ? [Number(named[3])] : [year - 1, year, year + 1];
  const dates = years.map((candidate) => calendarDate(candidate, month, Number(named[2])))
    .filter(Boolean).sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference));
  return dates[0]?.toISOString().slice(0, 10) ?? null;
}

// Literal templates expose numeric scores, numeric/date puzzles, and an optional skipped block.
export function compileTemplate(template) {
  template = template.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (!template || template.length > 300) throw new Error('Template must contain 1–300 characters.');
  for (const token of ['puzzle', 'score']) {
    if (template.split(`{${token}}`).length !== 2) {
      throw new Error(`Template must contain exactly one {${token}} token. Replace the changing ${token === 'puzzle' ? 'puzzle number or date' : 'score value'} with {${token}}.`);
    }
  }
  if (template.split('{skip}').length > 2) throw new Error('Template may contain at most one {skip} token.');
  if (/[{}]/.test(template.replace('{puzzle}', '').replace('{score}', '').replace('{skip}', ''))) {
    throw new Error('Only {puzzle}, {score}, and {skip} tokens are supported.');
  }
  const templateLines = template.split('\n');
  const lines = templateLines.map((line, index) => {
    if (line.includes('{skip}')) {
      if (line.trim() !== '{skip}' || index === 0 || index === templateLines.length - 1) {
        throw new Error('{skip} must be on its own line between other template lines.');
      }
      return '(?:[^\\r\\n]*\\n)*?';
    }
    const parts = line.split(/(\{puzzle\}|\{score\})/);
    const pattern = parts.map((part) => {
      if (part === '{puzzle}') return `(?<puzzle>${puzzlePattern})`;
      if (part === '{score}') return '(?<score>[+-]?\\d+(?:\\.\\d+)?)(?![\\w.,])';
      return escapeRegex(part).replace(/[ \t]+/g, '[ \\t]+');
    }).join('');
    return '[ \\t]*' + pattern + '[^\\r\\n]*' + (index < templateLines.length - 1 ? '\\n' : '$');
  });
  return new RegExp('^' + lines.join(''), 'im');
}

export function parseSubmission(content, template, referenceTimestamp = Date.now()) {
  if (typeof content !== 'string' || content.length > 20000) return null;
  const match = compileTemplate(template).exec(content.replace(/\r\n/g, '\n'));
  if (!match) return null;
  const score = Number(match.groups.score);
  const puzzle = normalizePuzzle(match.groups.puzzle, referenceTimestamp);
  if (!Number.isFinite(score) || puzzle === null) return null;
  return { puzzle, score };
}
