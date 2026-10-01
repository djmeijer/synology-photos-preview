import { access } from 'node:fs/promises';
import path from 'node:path';
import { defaults, readJson, validateSettings } from '../server/settings.ts';
export async function localSettings() {
  const settings = validateSettings(await readJson(path.resolve('.data/settings.json'), defaults));
  if (process.env.FFMPEG_PATH) settings.ffmpeg = process.env.FFMPEG_PATH;
  if (process.env.FFPROBE_PATH) settings.ffprobe = process.env.FFPROBE_PATH;
  if (process.env.MAGICK_PATH) settings.magick = process.env.MAGICK_PATH;
  else if (settings.magick === 'magick') {
    const portable = path.resolve('.tools/imagemagick/magick.exe');
    try { await access(portable); settings.magick = portable; } catch { /* Use PATH. */ }
  }
  return settings;
}
