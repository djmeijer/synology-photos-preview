import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversionJob, DiskBudget, type JobDependencies, Semaphore } from '../server/queue.ts';
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
    refill: async () => ({ items: ++refillCalls < 3 ? [...initial] : refillCalls === 3 ? [...initial, ...discovered] : [], skipped: [] })
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
  assert.equal(job.snapshot().mediaDateFrom, '2020-01-01T00:00:00.000Z');
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

test('date window uses the last 100 fetched identities before scheduling', async t => {
  const dir = await folder(t);
  for (const count of [1, 37, 100, 120]) {
    const input = items(count).map((item, index) => ({ ...item, size: count - index,
      takenAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString() }));
    const job = new ConversionJob('both', [...input, input[0]], defaults, dir, dependencies());
    const snapshot = job.snapshot();
    assert.equal(snapshot.mediaDateWindowCount, Math.min(count, 100));
    assert.equal(snapshot.mediaDateKnownCount, Math.min(count, 100));
    assert.equal(snapshot.mediaDateFrom, input[Math.max(0, count - 100)].takenAt);
    assert.equal(snapshot.mediaDateTo, input.at(-1)!.takenAt);
  }
});

test('date window carries across overlapping refills and counts missing dates', async t => {
  const dir = await folder(t);
  const input = items(112).map((item, index) => ({ ...item, space: index % 2 ? 'shared' as const : 'personal' as const,
    key: `${index % 2 ? 'shared' : 'personal'}:${index}:${item.component}`,
    takenAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString() }));
  let calls = 0;
  const job = new ConversionJob('both', input.slice(0, 110), defaults, dir, dependencies({
    refillIntervalMs: 5,
    refill: async () => ({ items: ++calls === 1 ? [input[0], ...input.slice(110)] : [], skipped: [] })
  })).start();
  await job.completion;
  assert.equal(job.snapshot().total, 112);
  assert.equal(job.snapshot().mediaDateFrom, input[12].takenAt);
  assert.equal(job.snapshot().mediaDateTo, input[111].takenAt);
  const unknown = new ConversionJob('personal', items(2).map((item, i) => ({ ...item, takenAt: i ? 'invalid' : undefined })), defaults, dir, dependencies());
  assert.equal(unknown.snapshot().mediaDateWindowCount, 2);
  assert.equal(unknown.snapshot().mediaDateKnownCount, 0);
  assert.equal(unknown.snapshot().mediaDateFrom, undefined);
  const oneDay = new ConversionJob('personal', items(2).map(item => ({ ...item, takenAt: '2021-01-01T00:00:00Z' })), defaults, dir, dependencies());
  assert.equal(oneDay.snapshot().mediaDateFrom, oneDay.snapshot().mediaDateTo);
});

test('skipped components warn without entering the pipeline and retry resets transient state', async t => {
  const dir = await folder(t), item = items(1)[0];
  const skipped = { key: 'personal:2:live_video', space: 'personal' as const, unitId: 2, filename: 'live.mov', reason: 'Unverified Live Photo component' };
  const job = new ConversionJob('personal', [item], defaults, dir, dependencies({
    refillIntervalMs: 5,
    refill: async () => ({ items: [], skipped: [skipped, skipped] })
  }), [skipped]).start();
  await job.completion;
  assert.equal(job.snapshot().success, 1); assert.equal(job.snapshot().total, 1);
  assert.equal(job.snapshot().skipped, 1); assert.equal(job.snapshot().warnings!.length, 1);
  assert.equal(job.status, 'completed_with_errors');
  const retryInput = { ...item, stage: 'failed' as const, error: 'Old failure', backend: 'old backend', percent: 80 };
  const retry = new ConversionJob('personal', [retryInput], defaults, dir, dependencies());
  assert.equal(retry.items[0].error, undefined); assert.equal(retry.items[0].backend, undefined);
  assert.equal(retry.items[0].percent, null); assert.equal(retry.snapshot().mediaDateWindowCount, 1);
});

test('a stale refill after the final upload cannot hide newly exposed work', async t => {
  const dir = await folder(t), base = dependencies();
  let uploaded!: () => void, calls = 0;
  const done = new Promise<void>(resolve => { uploaded = resolve; });
  const job = new ConversionJob('personal', items(1), defaults, dir, dependencies({
    upload: async (...args) => { await base.upload(...args); uploaded(); },
    refillIntervalMs: 10,
    refill: async () => {
      if (++calls === 1) { await done; await delay(10); return { items: items(1), skipped: [] }; }
      return { items: calls === 2 ? items(2).slice(1) : [], skipped: [] };
    }
  })).start();
  await job.completion;
  assert.equal(job.snapshot().success, 2); assert.equal(job.status, 'completed');
  assert.ok(calls >= 5);
});

test('new work on the third idle check resets all three confirmations', async t => {
  const dir = await folder(t); let idleChecks = 0, added = false, allSettled = false;
  const timestamps: number[] = [];
  const job = new ConversionJob('personal', items(1), defaults, dir, dependencies({
    refillIntervalMs: 15,
    refill: async () => {
      if (allSettled) {
        idleChecks++; timestamps.push(Date.now());
        if (!added && idleChecks === 3) { added = true; return { items: items(2).slice(1), skipped: [] }; }
      }
      return { items: [], skipped: [] };
    }
  })).start();
  job.on('change', () => { allSettled = job.snapshot().remaining === 0; });
  await job.completion;
  assert.equal(job.snapshot().success, 2); assert.equal(idleChecks, 6);
  assert.ok(timestamps[1] - timestamps[0] >= 10 && timestamps[2] - timestamps[1] >= 10);
});

test('pause suspends idle confirmation, resume restarts it, and stop cancels a pending check', async t => {
  const dir = await folder(t); let idle = 0, entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const job = new ConversionJob('personal', items(1), defaults, dir, dependencies({
    refillIntervalMs: 10,
    refill: async () => {
      if (job.snapshot().remaining === 0 && ++idle === 1) { entered(); await held; }
      return { items: [], skipped: [] };
    }
  })).start();
  t.after(() => job.stop());
  await entering; job.pause(); release(); await delay(40);
  assert.equal(idle, 1); assert.equal(job.status, 'paused');
  job.resume(); await job.completion;
  assert.equal(idle, 4); assert.equal(job.status, 'completed');
  const stopped = new ConversionJob('personal', items(1), defaults, dir, dependencies({
    refillIntervalMs: 10_000, refill: async () => ({ items: [], skipped: [] })
  })).start();
  while (stopped.snapshot().remaining) await delay(1);
  stopped.stop(); await stopped.completion;
  assert.equal(stopped.status, 'stopped');
});

test('refill failure drains admitted work and prevents a clean completion status', async t => {
  const dir = await folder(t);
  const job = new ConversionJob('personal', items(3), defaults, dir, dependencies({
    refill: async () => { throw new AppError('Queue listing unavailable'); }
  })).start();
  await job.completion;
  assert.equal(job.snapshot().success, 3); assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.snapshot().verificationError, 'Queue listing unavailable');
});

test('small staged budgets give unknown-size downloads a positive allowance', async t => {
  const dir = await folder(t);
  const budget = new DiskBudget({ ...defaults, maxStagedGiB: 1, downloads: 16, diskReserveGiB: 1 }, dir);
  const reservation = await budget.acquire(items(1)[0], new AbortController().signal);
  assert.equal(reservation.maxBytes, 32 * 1024 ** 2);
  reservation.release(); reservation.release();
});

test('pause during reservation blocks downloads and stop releases that reservation', async t => {
  const dir = await folder(t);
  for (const stop of [false, true]) {
    let entered!: () => void, release!: () => void, released = 0, downloads = 0;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const base = dependencies();
    const job = new ConversionJob('personal', items(1), defaults, dir, dependencies({
      reserve: async () => { entered(); await held; return { maxBytes: 1024, release: () => { released++; } }; },
      download: async (...args) => { downloads++; await base.download(...args); }
    })).start();
    await entering; job.pause(); release(); await delay(25);
    assert.equal(downloads, 0); assert.equal(released, 0);
    if (stop) job.stop(); else job.resume();
    await job.completion;
    assert.equal(downloads, stop ? 0 : 1); assert.equal(released, 1);
  }
});

test('failed item cleanup retains storage and acknowledged upload success', async t => {
  const dir = await folder(t); let released = 0;
  const job = new ConversionJob('personal', items(1), defaults, dir, dependencies({
    reserve: async () => ({ maxBytes: 1024, release: () => { released++; } }),
    cleanup: async () => { throw new Error('Locked file'); }
  })).start();
  await job.completion;
  assert.equal(released, 0); assert.equal(job.snapshot().success, 1); assert.equal(job.snapshot().failed, 0);
  assert.equal(job.status, 'completed_with_errors'); assert.match(job.snapshot().warnings![0], /file-0.jpg/);
  await rm(dir, { recursive: true, force: true });
  job.releaseRetainedReservations(); job.releaseRetainedReservations(); assert.equal(released, 1);
});
