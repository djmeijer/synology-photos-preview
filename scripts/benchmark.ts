import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { inspectHardware, MediaConverter } from '../server/media.ts';
import { Semaphore } from '../server/queue.ts';
import { localSettings } from './tools.ts';
import { fixtures } from './fixtures.ts';
import type { MediaItem } from '../shared/types.ts';

const settings = await localSettings(), hardware = await inspectHardware(settings);
if (!hardware.ffmpeg || !hardware.ffprobe || !hardware.magick) throw new Error('Configure FFmpeg, FFprobe and ImageMagick before benchmarking.');
const samples = process.argv[2] ? null : await fixtures(settings);
const inputs = samples ? [samples.file('photo.png'), samples.file('video.mp4')] : (await readdir(path.resolve(process.argv[2]))).map(name => path.resolve(process.argv[2], name));
const photos = inputs.filter(p => /\.(heic|heif|jpg|jpeg|png|tif|webp)$/i.test(p)), videos = inputs.filter(p => /\.(mp4|mov|mkv|avi|m4v|mts)$/i.test(p));
if (!photos.length || !videos.length) throw new Error('Benchmark folder must contain both photos and videos.');
const result: { kind: string; workers: number; seconds: number; filesPerSecond: number; runs: number[]; backends: string[] }[] = [];
for (const [kind, limits, sources, count] of [['images', [8, 16, 24], photos, 48], ['videos', [2, 4, 6, 8], videos, 16]] as const) {
  for (const workers of limits) {
    const runs: number[] = [], backends = new Set<string>();
    for (let repetition = 0; repetition < 3; repetition++) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'preview-benchmark-'));
      const converter = new MediaConverter({ ...settings, [kind]: workers }, hardware), semaphore = new Semaphore(workers);
      const signal = new AbortController().signal;
      const start = performance.now();
      try {
        await Promise.all(Array.from({ length: count }, (_, index) => semaphore.use(signal, async () => {
          const source = sources[index % sources.length], itemDirectory = await mkdtemp(path.join(directory, 'item-'));
          const item: MediaItem = { key: String(index), unitId: index, space: 'personal', component: kind === 'images' ? 'photo' : 'video', filename: path.basename(source), needThumbnail: true, needVideo: kind === 'videos' };
          await converter.convert(item, source, itemDirectory, signal, (_percent, backend) => backends.add(backend));
          await rm(itemDirectory, { recursive: true, force: true });
        })));
        runs.push((performance.now() - start) / 1000);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    const seconds = [...runs].sort((a, b) => a - b)[1];
    result.push({ kind, workers, seconds, filesPerSecond: count / seconds, runs, backends: [...backends] });
    console.log(`${kind}: ${workers} workers · median ${seconds.toFixed(2)}s · ${(count / seconds).toFixed(2)} files/s`);
  }
}
// Prefer the lowest worker count within 5% of the best measured throughput.
const recommended = Object.fromEntries(['images', 'videos'].map(kind => {
  const rows = result.filter(r => r.kind === kind), best = Math.max(...rows.map(r => r.filesPerSecond));
  return [kind, rows.find(r => r.filesPerSecond >= best * 0.95)!.workers];
}));
await mkdir('.benchmarks', { recursive: true });
await writeFile('.benchmarks/latest.json', JSON.stringify({ measuredAt: new Date().toISOString(), fixture: samples ? 'Synthetic 4032×3024 PNG and six-second 1080p H.264 with audio; conversion only, no NAS transfers' : path.resolve(process.argv[2]), hardware, result, recommended }, null, 2));
console.log(`Measured recommendation: ${JSON.stringify(recommended)}. Report: .benchmarks/latest.json. Settings are not changed automatically.`);
