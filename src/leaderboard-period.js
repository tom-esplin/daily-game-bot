// Monthly standings use original Discord message dates in this time zone.
export const LEADERBOARD_TIME_ZONE = 'America/Denver';
const monthFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: LEADERBOARD_TIME_ZONE, year: 'numeric', month: '2-digit',
});

function monthKey(date) {
  const parts = monthFormatter.formatToParts(date);
  return `${parts.find((part) => part.type === 'year').value}-${parts.find((part) => part.type === 'month').value}`;
}

export function leaderboardPeriodLabel(period, now = new Date()) {
  if (period === 'alltime') return 'All Time';
  if (period !== 'monthly') throw new Error('Choose Monthly or All Time for the leaderboard period.');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LEADERBOARD_TIME_ZONE, year: 'numeric', month: 'long',
  }).format(now);
}

export function submissionsForPeriod(submissions, period = 'monthly', now = new Date()) {
  if (period === 'alltime') return submissions;
  if (period !== 'monthly') throw new Error('Choose Monthly or All Time for the leaderboard period.');
  const currentMonth = monthKey(now);
  return submissions.filter((row) => Number.isFinite(row.created_at)
    && monthKey(new Date(row.created_at)) === currentMonth);
}
