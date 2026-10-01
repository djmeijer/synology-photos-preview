// Browser tests use the real Express app, SSE and scheduler; only NAS/media operations are mocked.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Studio, createApp } from '../server/app.ts';
import { ConversionJob } from '../server/queue.ts';
import { NasClient } from '../server/nas.ts';
import { NasError } from '../server/errors.ts';
import type { Library, MediaItem } from '../shared/types.ts';
class BrowserStudio extends Studio {
  override async connect(input: any) {
    if (input.password !== 'secret') throw new NasError(400, 'login');
    if (input.otp !== '123456') throw new NasError(403, 'login');
    this.nas = new NasClient(input.url, input.username);
    Object.assign(this.nas.connection, { connected: true, spaces: input.username === 'personal-only' ? ['personal'] : ['personal', 'shared'] });
    this.settings = { ...this.settings, nasUrl: input.url, username: input.username };
    this.changed();
  }
  override async disconnect() { this.nas = null; this.changed(); }
  override async start(input: { library?: Library; retryFailed?: boolean }) {
    if (this.job?.active) throw new Error('Already running');
    const library = input.retryFailed ? this.job!.library : input.library ?? this.settings.library;
    const username = this.nas!.connection.username;
    if (!input.retryFailed) this.settings = { ...this.settings, library };
    const items: MediaItem[] = input.retryFailed ? this.job!.failedItems() : Array.from({ length: 120 }, (_, i) => ({ key: `${library}:${i}:photo`, unitId: i, filename: `image-${i}.heic`, space: library === 'shared' ? 'shared' : i % 2 && library === 'both' ? 'shared' : 'personal', component: 'photo', needThumbnail: true, needVideo: false, takenAt: username === 'unknown-dates' ? undefined : username === 'one-day' ? '2021-01-01T00:00:00Z' : new Date(Date.UTC(2020, 0, i + 1)).toISOString() }));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'preview-browser-job-'));
    this.job = new ConversionJob(library, items, { ...this.settings, downloads: 1, images: 2, uploads: 1 }, directory, {
      reserve: async () => ({ release: () => {}, maxBytes: 1024 }),
      download: async (_item, source, signal, _max, progress) => { await delay(120, undefined, { signal }); await writeFile(source, 'source'); progress(100, 6); },
      convert: async (_item, _source, dir, signal, progress) => { await delay(300, undefined, { signal }); const output = path.join(dir, 'out.jpg'); await writeFile(output, 'preview'); progress(100, 'test'); return { thumb_sm: output }; },
      upload: async (_item, _outputs, signal, progress) => { await delay(100, undefined, { signal }); progress(100, 7); }
    }, username === 'warnings' ? [{ key: 'personal:999:live_video', unitId: 999, space: 'personal', filename: 'live.mov', reason: 'Unverified Live Photo component' }] : []);
    this.job.on('change', () => this.changed());
    const job = this.job;
    job.start();
    void job.completion.then(() => rm(directory, { recursive: true, force: true }));
    this.changed();
  }
}
const directory = path.resolve('.test-data/browser'); await mkdir(directory, { recursive: true });
const studio = new BrowserStudio(directory);
studio.hardware = { cpu: 'Mock desktop CPU', logicalCpus: 32, memoryGiB: 64, gpu: 'Mock NVIDIA GPU', ffmpeg: true, ffprobe: true, magick: true, heic: true, nvenc: true, cudaScale: true, hdrFilters: true, warnings: [] };
const server = createApp(studio, 4188).listen(4188, '127.0.0.1');
process.on('SIGTERM', () => { studio.job?.stop(); server.closeAllConnections(); server.close(); });
