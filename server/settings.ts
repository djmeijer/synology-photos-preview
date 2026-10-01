import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import type { Settings } from '../shared/types.ts';

export const defaults: Settings = {
  nasUrl: '', username: '', library: 'both', downloads: 4, images: 16, videos: 4, uploads: 2,
  softwareThreads: 2, cq: 23, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', magick: 'magick',
  tempDirectory: '', diskReserveGiB: 10, maxStagedGiB: 20
};
export function validateSettings(input: unknown, current = defaults): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Settings must be an object.');
  const result = { ...current };
  const values = input as Record<string, unknown>;
  const ranges: Partial<Record<keyof Settings, [number, number]>> = {
    downloads: [1, 16], images: [1, 32], videos: [1, 8], uploads: [1, 8],
    softwareThreads: [1, 8], cq: [15, 35], diskReserveGiB: [1, 1000], maxStagedGiB: [1, 1000]
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(defaults, key)) throw new AppError(`Unknown setting: ${key}`);
    const bounds = ranges[key as keyof Settings];
    if (bounds) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds[0] || value > bounds[1]) throw new AppError(`Invalid ${key}; expected ${bounds[0]}–${bounds[1]}.`);
    } else if (key === 'library') {
      if (typeof value !== 'string' || !['personal', 'shared', 'both'].includes(value)) throw new AppError('Invalid library.');
    } else if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) throw new AppError(`Invalid ${key}.`);
    Object.assign(result, { [key]: value });
  }
  return result;
}
export async function readJson<T>(filename: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
