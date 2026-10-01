import type { MediaItem } from './types.ts';

export function mediaDateRange(items: readonly MediaItem[]) {
  const dates = items.flatMap(item => {
    const timestamp = item.takenAt ? Date.parse(item.takenAt) : NaN;
    return Number.isFinite(timestamp) ? [new Date(timestamp).toISOString()] : [];
  }).sort();
  return {
    mediaDateActiveCount: items.length,
    mediaDateKnownCount: dates.length,
    ...(dates.length ? { mediaDateFrom: dates[0], mediaDateTo: dates.at(-1)! } : {})
  };
}
