export const DEFAULT_BACKFILL_LIMIT = 100;
export const MAX_BACKFILL_LIMIT = 10000;

export function validateBackfillLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BACKFILL_LIMIT) {
    throw new Error(`Backfill limit must be between 1 and ${MAX_BACKFILL_LIMIT.toLocaleString('en-US')}.`);
  }
}

export async function importChannelHistory(channel, store, { limit = DEFAULT_BACKFILL_LIMIT, onProgress } = {}) {
  validateBackfillLimit(limit);
  let scanned = 0;
  let matched = 0;
  let before;
  let nextProgress = 1000;
  while (scanned < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - scanned), ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const message of batch.values()) {
      matched += store.ingest(message);
      scanned++;
    }
    before = batch.last().id;
    if (scanned >= nextProgress && scanned < limit) {
      await onProgress?.({ scanned, matched, limit });
      nextProgress = scanned + 1000;
    }
  }
  return { scanned, matched };
}
