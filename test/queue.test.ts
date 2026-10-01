import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversionJob, type JobDependencies, Semaphore } from '../server/queue.ts';
import { defaults } from '../server/settings.ts';
import { AppError } from '../server/errors.ts';
import type { MediaItem } from '../shared/types.ts';
const items = (count: number): MediaItem[] => Array.from({ length: count }, (_, i) => ({ key: `personal:${i}:${i % 2 ? 'video' : 'photo'}`, space: 'personal', unitId: i, filename: `../file-${i}.jpg`, component: i % 2 ? 'video' : 'photo', needThumbnail: true, needVideo: !!(i % 2) }));
async function folder(t: test.TestContext) { const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-queue-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function dependencies(overrides: Partial<JobDependencies> = {}): JobDependencies {
  return {
    reserve: async () => ({ release: () => {}, maxBytes: 1024 }),
    download: async (_item, source, signal, _max, progress) => { await delay(5, undefined, { signal }); await writeFile(source, 'source'); progress(100, 6); },
    convert: async (_item, _source, directory, signal, progress) => { await delay(5, undefined, { signal }); const output = path.join(directory, 'out.jpg'); await writeFile(output, 'preview'); progress(100, 'mock'); return { thumb_sm: output }; },
    upload: async (_item, _outputs, signal, progress) => { await delay(5, undefined, { signal }); progress(100, 7); }, ...overrides
  };
}
test('starts expensive video work before photos to avoid a straggler tail', async t => {
  const dir = await folder(t);
  const input = items(4).map((item, index) => ({ ...item, size: (index + 1) * 100 }));
  const job = new ConversionJob('personal', input, defaults, dir, dependencies());
  assert.deepEqual(job.items.map(item => item.unitId), [3, 1, 2, 0]);
});
test('independent stage limits, duplicate prevention, cleanup, transfer progress and success acknowledgments', async t => {
  const dir = await folder(t), settings = { ...defaults, downloads: 2, images: 3, videos: 2, uploads: 1 };
  const active = { download: 0, image: 0, video: 0, upload: 0 }, peak = { ...active };
  const base = dependencies();
  async function track<T>(stage: keyof typeof active, action: () => Promise<T>) { active[stage]++; peak[stage] = Math.max(peak[stage], active[stage]); try { await delay(15); return await action(); } finally { active[stage]--; } }
  const list = items(30);
  const job = new ConversionJob('personal', [...list, ...list], settings, dir, dependencies({
    download: (...args) => track('download', () => base.download(...args)),
    convert: (...args) => track(args[0].component === 'photo' ? 'image' : 'video', () => base.convert(...args)),
    upload: (...args) => track('upload', async () => { if (args[0].unitId === 3) throw new AppError('NAS did not acknowledge upload'); await base.upload(...args); })
  })).start();
  assert.throws(() => job.start(), /already started/);
  await job.completion;
  assert.ok(peak.download <= 2 && peak.image <= 3 && peak.video <= 2 && peak.upload === 1);
  const snapshot = job.snapshot(); assert.equal(snapshot.total, 30); assert.equal(snapshot.success, 29); assert.equal(snapshot.failed, 1); assert.equal(snapshot.remaining, 0); assert.equal(snapshot.settledPercent, 100); assert.equal(snapshot.status, 'completed_with_errors');
  assert.equal(snapshot.downloadedBytes, 180); assert.equal(snapshot.uploadedBytes, 203); assert.equal(job.failedItems()[0].unitId, 3);
  assert.deepEqual(await readdir(dir), []);
});
test('Pause blocks new downloads while admitted files finish; Resume drains the backlog', async t => {
  const dir = await folder(t); let downloads = 0; let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const job = new ConversionJob('personal', items(8), { ...defaults, downloads: 1 }, dir, dependencies({ download: async (_i, source) => { downloads++; if (downloads === 1) await hold; await writeFile(source, 'source'); } })).start();
  while (!downloads) await delay(1);
  job.pause(); release(); await delay(100);
  assert.equal(downloads, 1); assert.equal(job.snapshot().success, 1); assert.equal(job.status, 'paused');
  job.resume(); await job.completion; assert.equal(job.snapshot().success, 8);
});
test('refills the queue while a slow file is still processing', async t => {
  const dir = await folder(t), initial = items(4).map((item, index) => ({ ...item, takenAt: new Date(Date.UTC(2020, index, 1)).toISOString() }));
  const discovered = items(6).slice(4).map((item, index) => ({ ...item, takenAt: new Date(Date.UTC(2021, index, 1)).toISOString() }));
  let releaseSlow!: () => void, refillCalls = 0;
  const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
  const downloaded = new Set<number>(), base = dependencies();
  const job = new ConversionJob('personal', initial, { ...defaults, downloads: 2, images: 2, videos: 2, uploads: 1 }, dir, dependencies({
    download: async (...args) => { downloaded.add(args[0].unitId); await base.download(...args); },
    convert: async (...args) => { if (args[0].unitId === 0) await slow; return base.convert(...args); },
    refillIntervalMs: 5,
    refill: async () => ++refillCalls < 3 ? [...initial] : refillCalls === 3 ? [...initial, ...discovered] : []
  })).start();

  const deadline = Date.now() + 2000;
  while (!downloaded.has(4)) {
    if (Date.now() > deadline) assert.fail('New work was not loaded around the slow file');
    await delay(5);
  }
  assert.equal(job.active, true);
  assert.equal(job.items.find(item => item.unitId === 0)?.stage, 'convert');
  releaseSlow(); await job.completion;
  assert.equal(job.snapshot().success, 6);
  assert.equal(job.snapshot().mediaDateFrom, '2021-01-01T00:00:00.000Z');
  assert.equal(job.snapshot().mediaDateTo, '2021-02-01T00:00:00.000Z');
  assert.ok(refillCalls >= 4);
});
test('Stop aborts active work, keeps acknowledged uploads and removes temporary files', async t => {
  const dir = await folder(t); let entered = false;
  const job = new ConversionJob('personal', items(10), { ...defaults, downloads: 1, images: 1, videos: 1, uploads: 1 }, dir, dependencies({ download: async (item, source, signal) => { if (item.unitId !== 1) { entered = true; await delay(10_000, undefined, { signal }); } await writeFile(source, 'source'); } })).start();
  while (!entered || job.snapshot().success < 1) await delay(2);
  job.stop(); await job.completion;
  assert.equal(job.status, 'stopped'); assert.equal(job.snapshot().success, 1); assert.equal(job.snapshot().failed, 0); assert.equal(job.snapshot().cancelled, 9); assert.deepEqual(await readdir(dir), []);
});
test('aborting a semaphore waiter does not consume a slot', async () => {
  const sem = new Semaphore(1), release = await sem.acquire();
  const controller = new AbortController(), waiting = sem.acquire(controller.signal); controller.abort(); await assert.rejects(waiting); release();
  const again = await sem.acquire(); again();
});
