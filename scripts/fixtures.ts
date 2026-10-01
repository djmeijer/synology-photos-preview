import path from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { command } from '../server/process.ts';
import type { Settings } from '../shared/types.ts';

export async function fixtures(settings: Settings, directory = path.resolve('.test-data/media'), suite: 'integration' | 'benchmark' = 'integration') {
  await mkdir(directory, { recursive: true });
  const file = (name: string) => path.join(directory, name);
  async function create(name: string, executable: string, args: string[]) {
    try { await access(file(name)); } catch { await command(executable, args, { timeoutMs: 120_000 }); }
  }
  await create('photo.png', settings.magick, ['-size', '4032x3024', 'gradient:#173b58-#eba980', '-seed', '42', '-attenuate', '0.2', '+noise', 'Gaussian', file('photo.png')]);
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-filter_threads', '2'];
  const video = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'];
  await create('video.mp4', settings.ffmpeg, [...common, ...video, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('video.mp4')]);
  if (suite === 'benchmark') return { directory, file };
  await create('rotated.mp4', settings.ffmpeg, [...common, '-display_rotation:v:0', '90', '-i', file('video.mp4'), '-c', 'copy', file('rotated.mp4')]);
  await create('silent.mp4', settings.ffmpeg, [...common, '-i', file('video.mp4'), '-c:v', 'copy', '-an', file('silent.mp4')]);
  await create('hevc10.mp4', settings.ffmpeg, [...common, ...video, '-t', '2', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p10le', file('hevc10.mp4')]);
  await create('hdr.mp4', settings.ffmpeg, [...common, ...video, '-t', '2', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', file('hdr.mp4')]);
  await writeFile(file('corrupt.mp4'), 'deliberately invalid media');
  try { await access(file('example.heic')); } catch {
    // libheif's upstream codec fixture; no personal media is downloaded.
    const response = await fetch('https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Cannot download the public libheif HEIC test fixture.');
    await writeFile(file('example.heic'), Buffer.from(await response.arrayBuffer()));
  }
  return { directory, file };
}
